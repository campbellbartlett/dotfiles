import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";
import { basename, extname } from "node:path";

const downloadImageSchema = Type.Object({
  url: Type.String({
    description: "HTTP(S) URL of the image to download.",
  }),
  filename: Type.Optional(
    Type.String({
      description:
        "Optional output filename. It will be sanitized and written under /tmp/.",
    }),
  ),
});

type DownloadImageInput = Static<typeof downloadImageSchema>;

const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
  ".tif",
  ".tiff",
  ".svg",
  ".avif",
  ".heic",
  ".heif",
]);

function sanitizeFilename(name: string): string {
  return basename(name).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

function extensionFromUrl(url: URL): string {
  const ext = extname(url.pathname).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext) ? ext : ".img";
}

function outputPathFor(params: DownloadImageInput): string {
  const url = new URL(params.url);
  const requested = params.filename?.trim();

  if (requested) {
    const safe = sanitizeFilename(requested);
    const ext = extname(safe) || extensionFromUrl(url);
    const stem = extname(safe) ? safe.slice(0, -extname(safe).length) : safe;
    return `/tmp/${stem}${ext}`;
  }

  const ext = extensionFromUrl(url);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `/tmp/pi-image-${id}${ext}`;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "download_image_url",
    label: "Download Image URL",
    description:
      "Download an image from an HTTP(S) URL to /tmp/ using curl and return the local file path.",
    promptSnippet: "Download an image URL to /tmp/ and return the local path",
    promptGuidelines: [
      "Use download_image_url when the user provides an image URL and you need a local file path for it.",
    ],
    parameters: downloadImageSchema,

    async execute(_toolCallId, params, signal, onUpdate) {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(params.url);
      } catch {
        return {
          isError: true,
          content: [{ type: "text", text: `Invalid URL: ${params.url}` }],
        };
      }

      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        return {
          isError: true,
          content: [
            { type: "text", text: "Only http:// and https:// image URLs are supported." },
          ],
        };
      }

      const outputPath = outputPathFor(params);
      onUpdate?.({ content: [{ type: "text", text: `Downloading to ${outputPath}...` }] });

      const result = await pi.exec(
        "curl",
        [
          "--fail",
          "--location",
          "--silent",
          "--show-error",
          "--max-time",
          "60",
          "--output",
          outputPath,
          "--write-out",
          "%{content_type}",
          params.url,
        ],
        { signal, timeout: 70000 },
      );

      const contentType = result.stdout.trim();
      if (result.code !== 0) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `curl failed with exit code ${result.code}: ${result.stderr.trim() || "unknown error"}`,
            },
          ],
          details: { path: outputPath, stderr: result.stderr, code: result.code },
        };
      }

      if (contentType && !contentType.toLowerCase().startsWith("image/")) {
        await pi.exec("rm", ["-f", outputPath], { signal, timeout: 5000 });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Downloaded content was not an image (Content-Type: ${contentType}).`,
            },
          ],
          details: { path: outputPath, contentType },
        };
      }

      return {
        content: [{ type: "text", text: outputPath }],
        details: { path: outputPath, contentType },
      };
    },
  });
}
