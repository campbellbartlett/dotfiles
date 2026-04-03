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

apt_install() {
  need_sudo apt-get install -y "$@"
}

ensure_apt_updated() {
  if [[ ! -f /tmp/.dotfiles-apt-updated ]]; then
    log "Updating apt package index"
    need_sudo apt-get update
    touch /tmp/.dotfiles-apt-updated
  fi
}

install_base_helpers() {
  ensure_apt_updated
  log "Installing base helpers"
  apt_install ca-certificates curl gpg unzip xz-utils
}

install_gh() {
  if have gh; then
    log "gh already installed"
    return
  fi

  log "Installing GitHub CLI"
  need_sudo mkdir -p /etc/apt/keyrings

  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | need_sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null

  need_sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg

  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | need_sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null

  ensure_apt_updated
  apt_install gh
}

install_nodejs() {
  if have node && have npm; then
    log "Node.js already installed: $(node -v)"
    return
  fi

  log "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | need_sudo bash -
  ensure_apt_updated
  apt_install nodejs
}

install_codex() {
  if have codex; then
    log "codex already installed"
    return
  fi

  install_nodejs

  log "Installing Codex CLI"
  need_sudo npm install -g @openai/codex
}

install_yazi() {
  if have yazi; then
    log "yazi already installed"
    return
  fi

  local arch version url tmpdir asset

  case "$(uname -m)" in
    x86_64) arch="x86_64-unknown-linux-gnu" ;;
    aarch64|arm64) arch="aarch64-unknown-linux-gnu" ;;
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

  log "Installing yazi (${version})"

  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' RETURN

  curl -fL "$url" -o "$tmpdir/yazi.zip"
  unzip -q "$tmpdir/yazi.zip" -d "$tmpdir"

  asset="$(find "$tmpdir" -maxdepth 2 -type f \( -name yazi -o -name ya \) | head -n1)"
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
}

stow_dotfiles() {
  local repo_root
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

  if ! have stow; then
    echo "stow is not installed. Put stow in the base image or install it first." >&2
    return 1
  fi

  log "Stowing dotfiles from $repo_root"

  shopt -s nullglob
  local dirs=()
  for dir in "$repo_root"/*; do
    [[ -d "$dir" ]] || continue
    case "$(basename "$dir")" in
      .git|scripts) continue ;;
    esac
    dirs+=("$(basename "$dir")")
  done
  shopt -u nullglob

  if [[ ${#dirs[@]} -eq 0 ]]; then
    log "No stow packages found, skipping"
    return
  fi

  (
    cd "$repo_root"
    stow --target="$HOME" "${dirs[@]}"
  )
}

main() {
  install_base_helpers
  install_gh
  install_codex
  install_yazi
  #stow_dotfiles

  log "Done"
  printf 'Versions:\n'
  have gh && printf '  gh: %s\n' "$(gh --version | head -n1)"
  have node && printf '  node: %s\n' "$(node -v)"
  have npm && printf '  npm: %s\n' "$(npm -v)"
  have codex && printf '  codex: installed\n'
  have yazi && printf '  yazi: %s\n' "$(yazi --version 2>/dev/null || echo installed)"
}
main "$@"
