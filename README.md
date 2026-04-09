# dotfiles

My dotfiles, managed with [GNU Stow](https://www.gnu.org/software/stow/).

## What's included

| Package    | Description                                    |
|------------|------------------------------------------------|
| `git`      | `.gitconfig` and global `.gitignore`           |
| `nvim`     | LazyVim-based Neovim config with catppuccin    |
| `starship` | Minimal starship prompt                        |
| `tmux`     | tmux config with catppuccin, TPM, vim-navigator|
| `zsh`      | Zsh config with history, completion, keybindings|

## Quick start

```bash
git clone git@github.com:campbellbartlett/dotfiles.git ~/.dotfiles
cd ~/.dotfiles
chmod +x install.sh
./install.sh
```

`install.sh` is idempotent — safe to run multiple times. It will:

1. Install base packages (via nix or apt, whichever is available)
2. Install tools: gh, node, neovim, starship, difftastic, yazi, tmux TPM
3. Set zsh as default shell
4. Symlink all config via `stow`
5. Bootstrap LazyVim plugins

## Layering your own specific config

The `.zshrc` sources all `*.zsh` files from `~/.zshrc.d/` at the end. This
lets a separate dotfiles repo drop in overrides without modifying any
files in this repo:

```
~/.zshrc.d/
└── my-zsh.zsh    # your own specific aliases, env vars, etc.
```

Stow packages from another dotfiles repo can overlay additional config (e.g.
git identity, extra nvim plugins) on top of this base.

## Structure

Each top-level directory is a stow package. Stow creates symlinks in `$HOME`
mirroring the package's directory structure:

```
git/.gitconfig      → ~/.gitconfig
zsh/.zshrc          → ~/.zshrc
tmux/.tmux.conf     → ~/.tmux.conf
nvim/.config/nvim/  → ~/.config/nvim/
starship/.config/   → ~/.config/starship.toml
```

## Requirements

- Linux system with nix or apt (nix is preferred if available)
- `sudo` access for package installation (apt only)
- Git and curl (install.sh will handle the rest)
