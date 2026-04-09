-- Options are automatically loaded before lazy.nvim startup
-- Default options that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/options.lua

-- Increase timeoutlen for multi-key combos (helps in tmux)
vim.opt.timeoutlen = 500

-- Disable autoformat on save
vim.g.autoformat = false

-- Material theme: use "oceanic" variant
vim.g.material_style = "oceanic"

-- Disable all animations (snacks.nvim)
vim.g.snacks_animate = false

-- Disable swap files
vim.opt.swapfile = false

-- Bigger scrolloff for context
vim.opt.scrolloff = 8

-- Smoother mouse scrolling
vim.opt.mouse = "a"
vim.opt.mousescroll = "ver:3,hor:3"

-- Reduce redraw overhead (helps over SSH)
vim.opt.lazyredraw = false
vim.opt.synmaxcol = 300
vim.opt.cursorline = true
vim.opt.cursorcolumn = false

-- Use system clipboard (works over SSH with OSC52)
vim.opt.clipboard = "unnamedplus"

-- Neovide GUI settings (if using Neovide to connect remotely)
vim.opt.guifont = "JetBrainsMono Nerd Font:h20"
if vim.g.neovide then
  vim.g.neovide_show_border = true
  vim.g.neovide_title_hidden = false
end
