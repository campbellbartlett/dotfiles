#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

log() {
  printf '\n==> %s\n' "$1"
}

have() {
  command -v "$1" >/dev/null 2>&1
}

need_sudo() {
  if [[ "${EUID}" -ne 0 ]]; then
    sudo "$@"
  else
    "$@"
  fi
}

# Set DOTFILES_SKIP_PACKAGES=1 to skip all package-manager operations.
DOTFILES_SKIP_PACKAGES="${DOTFILES_SKIP_PACKAGES:-0}"

# ---------------------------------------------------------------------------
# Package manager abstraction
# ---------------------------------------------------------------------------
# Prefer nix if available (e.g. Canva devboxes), fall back to apt.

PKG_MANAGER=""

detect_pkg_manager() {
  if have nix-env; then
    PKG_MANAGER="nix"
  elif have apt-get; then
    PKG_MANAGER="apt"
  else
    echo "No supported package manager found (need nix or apt)" >&2
    exit 1
  fi
  log "Using package manager: $PKG_MANAGER"
}

apt_updated=false

ensure_apt_updated() {
  if [[ "$apt_updated" == false ]]; then
    log "Updating apt package index"
    need_sudo apt-get update
    apt_updated=true
  fi
}

pkg_install() {
  # Usage: pkg_install <nix-pkg> <apt-pkg> [apt-pkg2 ...]
  # First arg is the nixpkgs attribute, rest are apt package names.
  local nix_pkg="$1"; shift
  local apt_pkgs=("$@")

  case "$PKG_MANAGER" in
    nix)
      nix profile install "nixpkgs#${nix_pkg}" 2>/dev/null || true
      ;;
    apt)
      ensure_apt_updated
      need_sudo apt-get install -y "${apt_pkgs[@]}"
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Installers
# ---------------------------------------------------------------------------

install_base_helpers() {
  log "Installing base helpers"

  case "$PKG_MANAGER" in
    nix)
      nix profile upgrade '.*' 2>/dev/null || true
      nix profile install \
        nixpkgs#git nixpkgs#curl nixpkgs#wget nixpkgs#stow \
        nixpkgs#ripgrep nixpkgs#tmux nixpkgs#tree-sitter 2>/dev/null || true
      ;;
    apt)
      ensure_apt_updated
      need_sudo apt-get install -y \
        bc build-essential bubblewrap ca-certificates curl git gpg stow \
        tmux ripgrep unzip xz-utils zsh zsh-autosuggestions zsh-syntax-highlighting
      ;;
  esac
}

install_gh() {
  if have gh; then
    log "gh already installed"
    return
  fi

  log "Installing GitHub CLI"

  case "$PKG_MANAGER" in
    nix)
      nix profile install nixpkgs#gh 2>/dev/null || true
      ;;
    apt)
      need_sudo mkdir -p /etc/apt/keyrings

      curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg |
        need_sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null

      need_sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg

      echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" |
        need_sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null

      ensure_apt_updated
      need_sudo apt-get install -y gh
      ;;
  esac
}

install_nodejs() {
  if have node && have npm; then
    log "Node.js already installed: $(node -v)"
    return
  fi

  log "Installing Node.js 22"

  case "$PKG_MANAGER" in
    nix)
      nix profile install nixpkgs#nodejs_22 2>/dev/null || true
      ;;
    apt)
      curl -fsSL https://deb.nodesource.com/setup_22.x | need_sudo bash -
      ensure_apt_updated
      need_sudo apt-get install -y nodejs
      ;;
  esac
}

install_starship() {
  if have starship; then
    log "starship already installed: $(starship --version)"
    return
  fi

  log "Installing starship"

  case "$PKG_MANAGER" in
    nix)
      nix profile install nixpkgs#starship 2>/dev/null || true
      ;;
    apt)
      curl -sS https://starship.rs/install.sh | sh -s -- -y
      ;;
  esac
}

install_nvim() {
  local nvim_version nvim_minor

  if have nvim; then
    nvim_version="$(nvim --version | head -n1 | awk '{print $2}')"
    nvim_minor="$(printf '%s\n' "$nvim_version" | sed -E 's/^v0\.([0-9]+)\..*/\1/')"
    if [[ "$nvim_minor" =~ ^[0-9]+$ ]] && ((nvim_minor >= 11)); then
      log "nvim already installed: $(nvim --version | head -n1)"
      return
    fi
  fi

  log "Installing Neovim"

  case "$PKG_MANAGER" in
    nix)
      nix profile install nixpkgs#neovim 2>/dev/null || true
      ;;
    apt)
      local arch version asset url tmpdir install_root

      case "$(uname -m)" in
      x86_64) arch="x86_64" ;;
      aarch64 | arm64) arch="arm64" ;;
      *)
        echo "Unsupported architecture for Neovim: $(uname -m)" >&2
        return 1
        ;;
      esac

      version="${NVIM_VERSION:-v0.11.5}"
      asset="nvim-linux-${arch}.tar.gz"
      url="https://github.com/neovim/neovim/releases/download/${version}/${asset}"

      tmpdir="$(mktemp -d)"
      trap 'rm -rf "$tmpdir"' RETURN

      curl -fL "$url" -o "$tmpdir/$asset"
      tar -xzf "$tmpdir/$asset" -C "$tmpdir"

      install_root="/opt/nvim-linux-${arch}"
      need_sudo rm -rf "$install_root"
      need_sudo mv "$tmpdir/nvim-linux-${arch}" "$install_root"
      need_sudo ln -sf "$install_root/bin/nvim" /usr/local/bin/nvim

      rm -rf "$tmpdir"
      trap - RETURN
      ;;
  esac
}

install_difftastic() {
  if have difft; then
    log "difftastic already installed"
    return
  fi

  log "Installing difftastic"

  case "$PKG_MANAGER" in
    nix)
      nix profile install nixpkgs#difftastic 2>/dev/null || true
      ;;
    apt)
      local arch version url tmpdir

      case "$(uname -m)" in
      x86_64) arch="x86_64-unknown-linux-gnu" ;;
      aarch64 | arm64) arch="aarch64-unknown-linux-gnu" ;;
      *)
        echo "Unsupported architecture for difftastic: $(uname -m)" >&2
        return 1
        ;;
      esac

      version="${DIFFT_VERSION:-latest}"
      if [[ "$version" == "latest" ]]; then
        version="$(curl -fsSL https://api.github.com/repos/Wilfred/difftastic/releases/latest | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')"
      fi

      url="https://github.com/Wilfred/difftastic/releases/download/${version}/difft-${arch}.tar.gz"

      tmpdir="$(mktemp -d)"
      trap 'rm -rf "$tmpdir"' RETURN

      curl -fL "$url" -o "$tmpdir/difft.tar.gz"
      tar -xzf "$tmpdir/difft.tar.gz" -C "$tmpdir"
      need_sudo install -m 0755 "$tmpdir/difft" /usr/local/bin/difft

      rm -rf "$tmpdir"
      trap - RETURN
      ;;
  esac
}

install_tpm() {
  local tpm_dir
  tpm_dir="${HOME}/.tmux/plugins/tpm"

  if [[ -d "$tpm_dir" ]]; then
    log "TPM already installed"
    return
  fi

  if ! have git; then
    echo "git is required to bootstrap TPM but is not installed." >&2
    return 1
  fi

  log "Installing tmux plugin manager (TPM)"
  mkdir -p "${HOME}/.tmux/plugins"
  git clone https://github.com/tmux-plugins/tpm "$tpm_dir"
}

install_pi() {
  if have pi; then
    log "pi already installed"
    return
  fi

  if ! have pnpm && ! have npm; then
    echo "pnpm or npm is required to install pi but neither is installed." >&2
    return 1
  fi

  log "Installing pi coding agent"

  if have pnpm; then
    # Ensure PNPM_HOME and global bin dir are configured
    if [[ -z "${PNPM_HOME:-}" ]]; then
      pnpm setup 2>/dev/null || true
      export PNPM_HOME="${HOME}/.local/share/pnpm"
      export PATH="$PNPM_HOME:$PATH"
    fi
    pnpm install -g @mariozechner/pi-coding-agent
  else
    npm install -g @mariozechner/pi-coding-agent
  fi
}

install_lazyvim() {
  if ! have nvim; then
    echo "nvim is required to bootstrap LazyVim but is not installed." >&2
    return 1
  fi

  log "Bootstrapping LazyVim"
  nvim --headless '+lua require("lazy").sync({ wait = true })' +qa 2>/dev/null || true
}

install_yazi() {
  if have yazi; then
    log "yazi already installed"
    return
  fi

  log "Installing yazi"

  case "$PKG_MANAGER" in
    nix)
      nix profile install nixpkgs#yazi 2>/dev/null || true
      ;;
    apt)
      local arch version url tmpdir asset

      case "$(uname -m)" in
      x86_64) arch="x86_64-unknown-linux-gnu" ;;
      aarch64 | arm64) arch="aarch64-unknown-linux-gnu" ;;
      *)
        echo "Unsupported architecture for yazi: $(uname -m)" >&2
        return 1
        ;;
      esac

      version="${YAZI_VERSION:-latest}"
      if [[ "$version" == "latest" ]]; then
        url="https://github.com/sxyazi/yazi/releases/latest/download/yazi-${arch}.zip"
      else
        url="https://github.com/sxyazi/yazi/releases/download/${version}/yazi-${arch}.zip"
      fi

      tmpdir="$(mktemp -d)"
      trap 'rm -rf "$tmpdir"' RETURN

      curl -fL "$url" -o "$tmpdir/yazi.zip"
      unzip -q "$tmpdir/yazi.zip" -d "$tmpdir"

      asset="$(find "$tmpdir" -maxdepth 2 -type f -name yazi | head -n1)"
      if [[ -z "$asset" ]]; then
        echo "Could not find yazi binaries in downloaded archive" >&2
        return 1
      fi

      local bindir
      bindir="$(dirname "$asset")"

      need_sudo install -m 0755 "$bindir/yazi" /usr/local/bin/yazi
      if [[ -f "$bindir/ya" ]]; then
        need_sudo install -m 0755 "$bindir/ya" /usr/local/bin/ya
      fi

      rm -rf "$tmpdir"
      trap - RETURN
      ;;
  esac
}

set_default_shell() {
  if ! have zsh; then
    return
  fi

  local zsh_path
  zsh_path="$(command -v zsh)"

  if [[ "$(getent passwd "$(whoami)" | cut -d: -f7)" == "$zsh_path" ]]; then
    log "zsh is already the default shell"
    return
  fi

  log "Setting zsh as default shell"
  if ! grep -qxF "$zsh_path" /etc/shells 2>/dev/null; then
    echo "$zsh_path" | need_sudo tee -a /etc/shells >/dev/null
  fi
  chsh -s "$zsh_path"
}

# ---------------------------------------------------------------------------
# Stow
# ---------------------------------------------------------------------------

stow_dotfiles() {
  local repo_root
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

  if ! have stow; then
    echo "stow is not installed." >&2
    return 1
  fi

  log "Stowing dotfiles from $repo_root"

  shopt -s nullglob
  local dirs=()
  for dir in "$repo_root"/*; do
    [[ -d "$dir" ]] || continue
    case "$(basename "$dir")" in
    .git | scripts) continue ;;
    esac
    dirs+=("$(basename "$dir")")
  done
  shopt -u nullglob

  if [[ ${#dirs[@]} -eq 0 ]]; then
    log "No stow packages found, skipping"
    return
  fi

  local backup_root="${HOME}/.dotfiles-backup"

  backup_stow_conflicts() {
    local package_name="$1"
    local package_root="$repo_root/$package_name"

    while IFS= read -r -d '' path; do
      local rel_path="${path#"$package_root"/}"
      local target="$HOME/$rel_path"
      local target_real
      target_real="$(readlink -f "$target" 2>/dev/null || true)"

      [[ -e "$target" || -L "$target" ]] || continue

      # Skip if already symlinked correctly
      if [[ -n "$target_real" && "$target_real" == "$path" ]]; then
        continue
      fi

      local backup_target="$backup_root/$rel_path"
      mkdir -p "$(dirname "$backup_target")"
      mv "$target" "$backup_target"
    done < <(find "$package_root" -type f -print0)
  }

  (
    cd "$repo_root"
    for dir in "${dirs[@]}"; do
      backup_stow_conflicts "$dir"
    done
    stow --restow --target="$HOME" "${dirs[@]}"
  )
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  if [[ "$DOTFILES_SKIP_PACKAGES" == "1" ]]; then
    log "DOTFILES_SKIP_PACKAGES=1, skipping package installation steps"
  else
    detect_pkg_manager
    install_base_helpers
    install_gh
    install_nodejs
    install_nvim
    install_starship
    install_difftastic
    install_yazi
    install_pi
    set_default_shell
  fi

  install_tpm
  stow_dotfiles
  install_lazyvim

  log "Done"
  printf 'Versions:\n'
  have gh       && printf '  gh:        %s\n' "$(gh --version | head -n1)"
  have node     && printf '  node:      %s\n' "$(node -v)"
  have nvim     && printf '  nvim:      %s\n' "$(nvim --version | head -n1)"
  have starship && printf '  starship:  %s\n' "$(starship --version | head -n1)"
  have difft    && printf '  difft:     %s\n' "$(difft --version 2>/dev/null || echo installed)"
  have yazi     && printf '  yazi:      %s\n' "$(yazi --version 2>/dev/null || echo installed)"
}
main "$@"
