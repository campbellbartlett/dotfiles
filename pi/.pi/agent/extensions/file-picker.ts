/**
 * File Picker Extension for pi
 *
 * Intercepts '@' typed at a word boundary and opens a snacks-style full-screen
 * file picker overlay. Files are enumerated by 'fd' with streaming updates.
 * Scoring uses a port of fzf's algorithm (same one snacks.nvim uses) for
 * boundary-aware, camelCase-aware fuzzy matching.
 *
 * UX:
 *   - Type '@' at start of message or after a space → picker opens
 *   - Type to filter, ↑↓ to navigate, Enter to select, Esc to cancel
 *   - Selecting inserts '@<relative-path> ' at the cursor
 *   - Cancelling inserts a plain '@' (so the character isn't lost)
 *   - Ctrl+U clears the query
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { CustomEditor } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// FZF scoring algorithm — ported from snacks.nvim (which ported it from fzf)
// https://github.com/folke/snacks.nvim/blob/main/lua/snacks/picker/core/score.lua
// ─────────────────────────────────────────────────────────────────────────────

const SCORE_MATCH = 16;
const SCORE_GAP_START = -3;
const SCORE_GAP_EXTENSION = -1;
const BONUS_BOUNDARY = 8;
const BONUS_CAMEL_123 = 7;    // camelCase or letter→digit transition
const BONUS_CONSECUTIVE = 4;
const BONUS_NONWORD = 8;
const BONUS_FIRST_CHAR_MULTIPLIER = 2;
const BONUS_NO_PATH_SEP = BONUS_BOUNDARY - 2; // +6 when match is entirely within the filename segment

// Character classes
const CLS_WHITE = 0,
  CLS_NONWORD = 1,
  CLS_DELIMITER = 2,
  CLS_LOWER = 3,
  CLS_UPPER = 4,
  CLS_NUMBER = 6;

const CHAR_CLASS = new Uint8Array(256);
for (let b = 0; b < 256; b++) {
  const c = String.fromCharCode(b);
  if (/\s/.test(c)) CHAR_CLASS[b] = CLS_WHITE;
  else if (/[/\\,:;|]/.test(c)) CHAR_CLASS[b] = CLS_DELIMITER;
  else if (b >= 48 && b <= 57) CHAR_CLASS[b] = CLS_NUMBER;
  else if (b >= 65 && b <= 90) CHAR_CLASS[b] = CLS_UPPER;
  else if (b >= 97 && b <= 122) CHAR_CLASS[b] = CLS_LOWER;
  else CHAR_CLASS[b] = CLS_NONWORD;
}

// Pre-compute boundary/bonus matrix for all prev×curr class pairs.
// NOTE: the two `if` blocks are intentionally separate, not `if/else if`.
// When curr > CLS_NONWORD but prev is not WHITE/DELIMITER/NONWORD (e.g.
// prev=LOWER, curr=UPPER for camelCase), the first block sets bonus=0 and
// falls through to the second block — exactly mirroring the Lua fall-through
// in snacks/fzf. Using `else if` here was a bug that zeroed camelCase bonuses.
const BONUS_MATRIX: number[][] = [];
for (let prev = 0; prev <= 6; prev++) {
  BONUS_MATRIX[prev] = [];
  for (let curr = 0; curr <= 6; curr++) {
    let bonus = 0;
    // Block 1: boundary bonus when a letter/number/delimiter follows
    // whitespace, another delimiter, or a non-word character.
    if (curr > CLS_NONWORD) {
      if (prev === CLS_WHITE) bonus = BONUS_BOUNDARY + 2;
      else if (prev === CLS_DELIMITER) bonus = BONUS_BOUNDARY + 1;
      else if (prev === CLS_NONWORD) bonus = BONUS_BOUNDARY;
    }
    // Block 2: camelCase / nonword transitions — only when Block 1 didn't match.
    if (bonus === 0) {
      if (
        (prev === CLS_LOWER && curr === CLS_UPPER) ||
        (prev !== CLS_NUMBER && curr === CLS_NUMBER)
      ) {
        bonus = BONUS_CAMEL_123;
      } else if (curr === CLS_NONWORD || curr === CLS_DELIMITER) {
        bonus = BONUS_NONWORD;
      } else if (curr === CLS_WHITE) {
        bonus = BONUS_BOUNDARY + 2;
      }
    }
    BONUS_MATRIX[prev]![curr] = bonus;
  }
}

/**
 * Score a single embedding of `p` in `s` starting the search at `startFrom`.
 * BOTH `s` and `p` must already be lowercased by the caller — no allocations here.
 */
function fzfScoreFrom(s: string, p: string, startFrom: number): number {
  const n = p.length;

  // Find the first valid embedding starting no earlier than startFrom
  let firstMatchPos = -1;
  let pi = 0;
  for (let i = startFrom; i < s.length && pi < n; i++) {
    if (s[i] === p[pi]) {
      if (pi === 0) firstMatchPos = i;
      pi++;
    }
  }
  if (pi < n) return -Infinity;

  // Score that embedding
  let score = 0;
  let prevClass = CLS_WHITE;
  // Seed prevClass from the character just before firstMatchPos for accurate
  // boundary detection (e.g. '/' before 'F' in '…/FileService…').
  if (firstMatchPos > 0) {
    prevClass = CHAR_CLASS[s.charCodeAt(firstMatchPos - 1)] ?? CLS_NONWORD;
  }
  let consecutive = 0;
  let firstBonus = 0;
  let prevPos = -1;

  pi = 0;
  for (let i = firstMatchPos; i < s.length && pi < n; i++) {
    const b = s.charCodeAt(i);
    const cls = CHAR_CLASS[b] ?? CLS_NONWORD;

    if (s[i] === p[pi]) {
      const gap = prevPos === -1 ? 0 : i - prevPos - 1;
      if (gap > 0) {
        score += SCORE_GAP_START + (gap - 1) * SCORE_GAP_EXTENSION;
        consecutive = 0;
        firstBonus = 0;
      }
      let bonus = BONUS_MATRIX[prevClass]?.[cls] ?? 0;
      if (consecutive === 0) {
        firstBonus = bonus;
      } else {
        if (bonus >= BONUS_BOUNDARY && bonus > firstBonus) firstBonus = bonus;
        bonus = Math.max(bonus, firstBonus, BONUS_CONSECUTIVE);
      }
      consecutive++;
      score += SCORE_MATCH + (pi === 0 ? bonus * BONUS_FIRST_CHAR_MULTIPLIER : bonus);
      prevPos = i;
      pi++;
    }

    prevClass = cls;
  }

  // BONUS_NO_PATH_SEP: if the match starts in the filename segment (no '/' after
  // firstMatchPos), boost the score. This prefers matching inside the filename
  // over matching path components, matching snacks/fzf behaviour.
  if (s.indexOf("/", firstMatchPos + 1) === -1) {
    score += BONUS_NO_PATH_SEP;
  }

  return score;
}

/**
 * Score a pre-lowercased path against a pre-lowercased single token.
 *
 * Like the real fzf (and snacks.nvim), tries every starting position of
 * p[0] in the string and keeps the best score — critical so that a query
 * like "FileServiceServer" ranks the filename match over the scattered
 * path-prefix match.
 *
 * Both arguments MUST already be lowercased. No string allocation happens
 * inside this function — call toLowerCase() once before entering the loop.
 *
 * Returns -Infinity if the pattern does not match.
 */
function fzfScore(lower: string, lowerPattern: string): number {
  if (lowerPattern.length === 0) return 0;

  const firstChar = lowerPattern[0]!;
  let bestScore = -Infinity;
  let pos = 0;

  while (pos < lower.length) {
    const start = lower.indexOf(firstChar, pos);
    if (start === -1) break;
    const score = fzfScoreFrom(lower, lowerPattern, start);
    if (score > bestScore) bestScore = score;
    pos = start + 1;
  }

  return bestScore;
}

// ─────────────────────────────────────────────────────────────────────────────
// Token parsing — snacks-compatible query syntax
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A parsed query token with its matching mode and flags.
 *
 * Syntax (same as snacks/fzf):
 *   token        fuzzy match (default)
 *   'token       exact substring (no fuzzy)
 *   ^token       exact prefix of basename or full path
 *   token$       exact suffix — great for extension filtering (e.g. java$)
 *   !token       negation — exclude paths that match this token
 *   (modifiers can combine: !^src  means "does NOT start with src")
 *
 * Smartcase: if the token contains any uppercase letter, matching is
 * case-sensitive. All-lowercase tokens are case-insensitive.
 */
interface ParsedToken {
  pattern: string;        // text to match (original case)
  lower: string;          // lowercased version
  caseSensitive: boolean; // true when token has uppercase (smartcase)
  mode: "fuzzy" | "exact" | "prefix" | "suffix";
  inverse: boolean;       // true for '!' tokens
}

function parseTokens(query: string): ParsedToken[] {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((raw) => {
      let s = raw;
      let inverse = false;
      let mode: ParsedToken["mode"] = "fuzzy";

      if (s.startsWith("!")) { inverse = true; s = s.slice(1); }
      if (s.startsWith("^")) { mode = "prefix"; s = s.slice(1); }
      else if (s.endsWith("$") && s.length > 1) { mode = "suffix"; s = s.slice(0, -1); }
      else if (s.startsWith("'")) { mode = "exact"; s = s.slice(1); }

      const caseSensitive = s !== s.toLowerCase(); // smartcase
      return { pattern: s, lower: s.toLowerCase(), caseSensitive, mode, inverse };
    })
    .filter((t) => t.pattern.length > 0);
}

/**
 * Score a FileEntry against a single parsed token.
 * Returns -Infinity for no match, a positive number for a match.
 * For non-fuzzy modes a flat score proportional to pattern length is used
 * so results remain sortable alongside fuzzy scores.
 */
function scoreToken(entry: FileEntry, token: ParsedToken): number {
  // Smartcase: use original-case strings when token has uppercase.
  const str = token.caseSensitive ? entry.path : entry.lower;
  const pat = token.caseSensitive ? token.pattern : token.lower;
  if (!pat) return 0;

  let score: number;
  switch (token.mode) {
    case "fuzzy":
      score = fzfScore(str, pat);
      break;
    case "exact":
      score = str.includes(pat) ? SCORE_MATCH * pat.length : -Infinity;
      break;
    case "prefix": {
      // Check basename first (most natural), then the full path.
      const base = token.caseSensitive ? entry.base : entry.base.toLowerCase();
      score = base.startsWith(pat) || str.startsWith(pat)
        ? SCORE_MATCH * pat.length
        : -Infinity;
      break;
    }
    case "suffix":
      score = str.endsWith(pat) ? SCORE_MATCH * pat.length : -Infinity;
      break;
  }

  // Inverse (!) tokens: match only when the pattern is NOT found.
  if (token.inverse) return score === -Infinity ? SCORE_MATCH : -Infinity;
  return score;
}

/**
 * Score a FileEntry against all tokens (AND logic).
 * Returns the sum of token scores, or -Infinity if any required token fails.
 */
function scoreEntry(entry: FileEntry, tokens: ParsedToken[]): number {
  let total = 0;
  for (const token of tokens) {
    const s = scoreToken(entry, token);
    if (s === -Infinity) return -Infinity;
    total += s;
  }
  return total;
}

// ─────────────────────────────────────────────────────────────────────────────
// File enumeration using fd (streaming, batched)
// ─────────────────────────────────────────────────────────────────────────────

function resolveWorkingFd(): string | undefined {
  const pathValue = process.env.PATH ?? "";
  const candidates: string[] = [];

  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = join(dir, "fd");
    if (existsSync(candidate) && !candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  }

  if (!candidates.includes("fd")) candidates.push("fd");

  for (const candidate of candidates) {
    try {
      const result = spawnSync(candidate, ["--version"], { stdio: "pipe", encoding: "utf8" });
      if (result.status === 0) return candidate;
    } catch {}
  }

  return undefined;
}

function enumerateFiles(
  cwd: string,
  onBatch: (files: string[]) => void,
  onDone: () => void,
  signal: AbortSignal,
  onError?: (message: string) => void,
): void {
  const fdCommand = resolveWorkingFd();
  if (!fdCommand) {
    onError?.("File picker needs a working 'fd' binary, but none was found on PATH.");
    onDone();
    return;
  }

  const child = spawn(
    fdCommand,
    [
      "--type", "f",
      "--type", "l", // include symlinks to files
      "--color", "never",
      "--exclude", ".git",
      "--strip-cwd-prefix",
    ],
    { cwd, stdio: ["ignore", "pipe", "ignore"] },
  );

  let buf = "";
  let batch: string[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (batch.length > 0) {
      onBatch([...batch]);
      batch = [];
    }
  };

  signal.addEventListener(
    "abort",
    () => {
      child.kill("SIGTERM");
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 200);
    },
    { once: true },
  );

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (signal.aborted) return;
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (line) batch.push(line);
    }
    // Flush immediately when batch is large, otherwise debounce at 100ms
    if (batch.length >= 500) {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      flush();
    } else if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flush();
      }, 100);
    }
  });

  child.on("close", (code) => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (buf.trim()) batch.push(buf.trim());
    flush();
    if (!signal.aborted && code && code !== 0 && batch.length === 0) {
      onError?.(`File picker failed to run '${fdCommand}' (exit code ${code}).`);
    }
    onDone();
  });

  child.on("error", (error) => {
    onError?.(`File picker failed to start '${fdCommand}': ${error.message}`);
    onDone();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// File Picker Modal component
// ─────────────────────────────────────────────────────────────────────────────

// Pre-processed file entry: path is the original for display/insertion;
// lower is computed once so scoring never calls toLowerCase().
interface FileEntry {
  path: string;
  lower: string; // path.toLowerCase() — computed once at add-time
  base: string;  // basename
}

interface ScoredFile {
  path: string;
  basename: string;
  score: number;
}

const MAX_VISIBLE = 15; // result rows shown at once
const MAX_RESULTS = 2000; // max items kept in displayed list
const SCORE_CHUNK = 20_000; // files scored per setImmediate tick (~2 ms/tick)

function padRight(s: string, width: number): string {
  const vis = visibleWidth(s);
  return vis < width ? s + " ".repeat(width - vis) : s;
}

// Truncate a plain (no ANSI) string from the left, keeping the tail.
// "…/file/server/rpc" is more useful than "file_server/src/main/ja…"
function truncateLeft(s: string, width: number): string {
  if (s.length <= width) return s;
  return "\u2026" + s.slice(-(width - 1));
}

class FilePickerModal {
  private query = "";
  private allFiles: FileEntry[] = [];
  private displayed: ScoredFile[] = [];
  private selectedIdx = 0;
  private scrollOffset = 0;
  private isLoading = true;
  private errorMessage?: string;
  private cachedWidth?: number;
  private cachedLines?: string[];

  // --- async scoring state ---
  // Incremented on every new score run; checked inside each tick so stale
  // runs self-cancel without any extra bookkeeping.
  private scoringGen = 0;
  // Debounce timer handle
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  // Subset optimisation: the entries that matched the last completed query.
  // When the user extends the query (e.g. "file" → "fileS"), we only need
  // to re-score this smaller set instead of all 543k files.
  private lastMatchedEntries: FileEntry[] = [];
  private lastScoredQuery = "";

  onSelect?: (path: string) => void;
  onCancel?: () => void;

  constructor(
    private tui: { requestRender(): void },
    private theme: Theme,
    cwd: string,
    signal: AbortSignal,
    onWarning?: (message: string) => void,
  ) {
    enumerateFiles(
      cwd,
      (batch) => {
        // Pre-lowercase once here so scoring never allocates a string per file.
        for (const path of batch) {
          this.allFiles.push({ path, lower: path.toLowerCase(), base: basename(path) });
        }
        // Show new files arriving while the picker is idle (no active query)
        if (!this.query) {
          this.invalidate();
          this.tui.requestRender();
        }
        // Kick off a (debounced) rescore to surface newly arrived files in
        // results — uses a longer debounce so we don't thrash during the
        // initial fd stream.
        this.scheduleRefilter(150);
      },
      () => {
        this.isLoading = false;
        this.scheduleRefilter(0);
      },
      signal,
      (message) => {
        this.errorMessage = message;
        this.isLoading = false;
        this.invalidate();
        this.tui.requestRender();
        onWarning?.(message);
      },
    );
  }

  // Queue a refilter. `delayMs` lets callers use a longer debounce during
  // initial file loading to avoid re-scoring on every incoming batch.
  private scheduleRefilter(delayMs = 30): void {
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.startScoring();
    }, delayMs);
  }

  // Kick off a non-blocking, cancellable scoring run.
  private startScoring(): void {
    const lowerQuery = this.query.toLowerCase();
    const gen = ++this.scoringGen; // any previous run will see gen mismatch and stop

    // Parse tokens — supports modifiers like !token, ^prefix, suffix$, 'exact.
    const tokens = parseTokens(this.query);

    // ── Subset optimisation ───────────────────────────────────────────────────
    // Only valid when the new query is a plain extension of the previous one
    // (snacks: `not pattern:find("[^%s%w]")`).
    // Skip subset if the query contains modifier chars (!, ^, $, ') because
    // adding/removing a modifier changes the match set non-monotonically.
    const hasModifiers = /[!'^$]/.test(this.query);
    const isRefinement =
      lowerQuery.startsWith(this.lastScoredQuery) &&
      this.lastScoredQuery.length > 0 &&
      !this.isLoading &&
      !hasModifiers;
    const candidates: FileEntry[] = isRefinement ? this.lastMatchedEntries : this.allFiles;

    // No query: show files as-is without scoring (O(1)).
    if (tokens.length === 0) {
      this.displayed = this.allFiles.slice(0, MAX_RESULTS).map((e) => ({
        path: e.path,
        basename: e.base,
        score: 0,
      }));
      this.lastMatchedEntries = this.allFiles.slice();
      this.lastScoredQuery = "";
      this.clampSelection();
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // ── Async chunked scoring ─────────────────────────────────────────────────
    const results: { entry: FileEntry; score: number }[] = [];
    let i = 0;

    const tick = () => {
      if (this.scoringGen !== gen) return;

      const end = Math.min(i + SCORE_CHUNK, candidates.length);
      for (; i < end; i++) {
        const entry = candidates[i]!;
        const score = scoreEntry(entry, tokens);
        if (score > -Infinity) results.push({ entry, score });
      }

      if (i < candidates.length) {
        setImmediate(tick);
      } else {
        if (this.scoringGen !== gen) return;
        results.sort((a, b) => b.score - a.score);
        this.lastMatchedEntries = results.map((r) => r.entry);
        this.lastScoredQuery = lowerQuery;
        this.displayed = results.slice(0, MAX_RESULTS).map((r) => ({
          path: r.entry.path,
          basename: r.entry.base,
          score: r.score,
        }));
        this.clampSelection();
        this.invalidate();
        this.tui.requestRender();
      }
    };

    setImmediate(tick);
  }

  private clampSelection(): void {
    this.selectedIdx = Math.min(this.selectedIdx, Math.max(0, this.displayed.length - 1));
    this.clampScroll();
  }

  private clampScroll(): void {
    const maxScroll = Math.max(0, this.displayed.length - MAX_VISIBLE);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));
    if (this.selectedIdx < this.scrollOffset) {
      this.scrollOffset = this.selectedIdx;
    } else if (this.selectedIdx >= this.scrollOffset + MAX_VISIBLE) {
      this.scrollOffset = this.selectedIdx - MAX_VISIBLE + 1;
    }
  }


  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.onCancel?.();
      return;
    }
    if (matchesKey(data, Key.up)) {
      if (this.selectedIdx > 0) {
        this.selectedIdx--;
        this.clampScroll();
        this.invalidate();
        this.tui.requestRender();
      }
      return;
    }
    if (matchesKey(data, Key.down)) {
      if (this.selectedIdx < this.displayed.length - 1) {
        this.selectedIdx++;
        this.clampScroll();
        this.invalidate();
        this.tui.requestRender();
      }
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const item = this.displayed[this.selectedIdx];
      if (item) this.onSelect?.(item.path);
      return;
    }
    // Ctrl+U: clear query
    if (data === "\x15") {
      this.query = "";
      this.selectedIdx = 0;
      this.scrollOffset = 0;
      this.scheduleRefilter(0);
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      if (this.query.length > 0) {
        this.query = this.query.slice(0, -1);
        this.selectedIdx = 0;
        this.scrollOffset = 0;
        this.scheduleRefilter();
        this.invalidate();
        this.tui.requestRender();
      }
      return;
    }
    // Printable characters → append to query
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.query += data;
      this.selectedIdx = 0;
      this.scrollOffset = 0;
      this.scheduleRefilter();
      this.invalidate();
      this.tui.requestRender();
    }
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  // Renders the modal content at the given inner width (no border).
  private renderInner(width: number): string[] {
    const t = this.theme;
    const lines: string[] = [];
    const sep = t.fg("borderMuted", "─".repeat(width));

    // ── Title ──
    lines.push(t.fg("accent", t.bold("  ❯ Find Files")));

    // ── Search input ──
    const cursor = t.fg("accent", "█");
    const queryLine = `  ${t.fg("accent", "❯")} ${this.query}${cursor}`;
    lines.push(truncateToWidth(queryLine, width));

    lines.push(sep);

    // ── Status ──
    const matchCount =
      this.query && this.displayed.length < this.allFiles.length
        ? ` · ${this.displayed.length} matches`
        : "";
    const loadIndicator = this.isLoading ? " (scanning…)" : "";
    const statusLine = `  ${this.allFiles.length} files${matchCount}${loadIndicator}`;
    lines.push(truncateToWidth(t.fg("dim", statusLine), width));

    // ── Results ──
    if (this.errorMessage) {
      lines.push(t.fg("warning", `  ${this.errorMessage}`));
    } else if (this.displayed.length === 0 && !this.isLoading) {
      lines.push(t.fg("warning", "  (no matches)"));
    } else {
      // Column widths: 3 prefix | N filename | 2 gap | rest dirname
      const prefixCols = 3;
      const gapCols = 2;
      const nameCols = Math.max(20, Math.floor((width - prefixCols - gapCols) * 0.38));
      const dirCols = Math.max(10, width - prefixCols - nameCols - gapCols);

      const visible = this.displayed.slice(
        this.scrollOffset,
        this.scrollOffset + MAX_VISIBLE,
      );

      for (let i = 0; i < visible.length; i++) {
        const item = visible[i]!;
        const isSelected = this.scrollOffset + i === this.selectedIdx;

        const dir = item.path.includes("/")
          ? item.path.slice(0, item.path.lastIndexOf("/"))
          : ".";

        const nameTrunc =
          visibleWidth(item.basename) > nameCols
            ? truncateToWidth(item.basename, nameCols - 1, "…")
            : item.basename;
        const namePadded = padRight(nameTrunc, nameCols);
        // Left-truncate the directory so the end of the path (closest to the
        // filename) is always visible rather than the repo root.
        const dirTrunc = truncateLeft(dir, dirCols);

        let line: string;
        if (isSelected) {
          line =
            t.fg("accent", " ❯ ") +
            t.fg("accent", t.bold(namePadded)) +
            "  " +
            t.fg("muted", dirTrunc);
        } else {
          line = "   " + namePadded + "  " + t.fg("dim", dirTrunc);
        }
        lines.push(truncateToWidth(line, width));
      }
    }

    // ── Scroll indicator (only when list is longer than viewport) ──
    if (this.displayed.length > MAX_VISIBLE) {
      const end = Math.min(this.scrollOffset + MAX_VISIBLE, this.displayed.length);
      const indicator = `  ${this.scrollOffset + 1}–${end} of ${this.displayed.length}`;
      lines.push(truncateToWidth(t.fg("dim", indicator), width));
    }

    lines.push(sep);

    // ── Selected path (full path of the highlighted item) ──
    // Shown above the help line so you can always read the complete path
    // regardless of how narrow the window is.
    const selectedItem = this.displayed[this.selectedIdx];
    if (selectedItem) {
      lines.push(truncateToWidth(t.fg("muted", `  ${selectedItem.path}`), width));
    }

    // ── Help ──
    lines.push(t.fg("dim", "  ↑↓ navigate  enter select  esc cancel  ctrl+u clear  'exact  ^prefix  suffix$  !negate"));

    return lines;
  }

  // Renders the modal with a Unicode box border in borderAccent colour.
  // The border is 1 char wide on each side + 1 space of padding = 4 chars total
  // removed from the width passed in by the overlay system.
  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const t = this.theme;
    const border = (s: string) => t.fg("borderAccent", s);

    // Inner content is 4 chars narrower: │·content·│
    const innerWidth = Math.max(20, width - 4);
    const innerLines = this.renderInner(innerWidth);

    const horiz = "─".repeat(width - 2);
    const result: string[] = [
      border("┌" + horiz + "┐"),
      ...innerLines.map((line) => {
        // Pad every content line to exactly innerWidth so the right │ is flush.
        const padded = padRight(line, innerWidth);
        return border("│") + " " + padded + " " + border("│");
      }),
      border("└" + horiz + "┘"),
    ];

    this.cachedLines = result;
    this.cachedWidth = width;
    return result;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom Editor — intercepts '@' at word boundaries
// ─────────────────────────────────────────────────────────────────────────────

class FilePickerEditor extends CustomEditor {
  onOpenPicker?: () => void;
  private pickerActive = false;

  setPickerActive(active: boolean): void {
    this.pickerActive = active;
  }

  handleInput(data: string): void {
    // While the picker overlay is open, swallow all editor input so nothing
    // sneaks through to the editor underneath.
    if (this.pickerActive) return;

    if (data === "@" && this.isAtWordBoundary()) {
      this.onOpenPicker?.();
      return;
    }

    super.handleInput(data);
  }

  private isAtWordBoundary(): boolean {
    const text = this.getText();
    if (text.length === 0) return true;
    const last = text[text.length - 1]!;
    return last === " " || last === "\n" || last === "\t";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension entry point
// ─────────────────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent((tui, editorTheme, kb) => {
      const editor = new FilePickerEditor(tui, editorTheme, kb);

      editor.onOpenPicker = () => {
        editor.setPickerActive(true);
        const ac = new AbortController();

        // Defer by one tick to avoid calling ctx.ui.custom() synchronously
        // from inside the TUI's input dispatch loop.
        setImmediate(() => {
          ctx.ui
            .custom<string | null>(
              (overlayTui, overlayTheme, _kb, done) => {
                const modal = new FilePickerModal(
                  overlayTui,
                  overlayTheme,
                  ctx.cwd,
                  ac.signal,
                  (message) => ctx.ui.notify(message, "warning"),
                );
                modal.onSelect = (path) => {
                  ac.abort();
                  done(path);
                };
                modal.onCancel = () => {
                  ac.abort();
                  done(null);
                };
                return {
                  render: (w) => modal.render(w),
                  invalidate: () => modal.invalidate(),
                  handleInput: (d) => modal.handleInput(d),
                };
              },
              {
                overlay: true,
                overlayOptions: {
                  width: "72%",
                  minWidth: 60,
                  maxHeight: "75%",
                  anchor: "top-center",
                  offsetY: 2,
                },
              },
            )
            .then((path) => {
              editor.setPickerActive(false);
              if (path !== null && path !== undefined) {
                // Insert the selected path with @ prefix
                editor.insertTextAtCursor(`@${path} `);
              } else {
                // Cancelled — insert a bare @ so the character isn't lost
                editor.insertTextAtCursor("@");
              }
            });
        });
      };

      return editor;
    });
  });
}
