return {
  {
    "marko-cerovac/material.nvim",
    lazy = false,
    priority = 1000,
    config = function()
      require("material").setup({
        custom_highlights = {
          FlashLabel = { fg = "#ffffff", bg = "#ff007c", bold = true },
          FlashMatch = { fg = "#89ddff", bg = "#2b3a4f" },
          FlashCurrent = { fg = "#ffffff", bg = "#545c7e" },
        },
        disable = {
          background = true,
        },
      })
    end,
  },
  {
    "rebelot/kanagawa.nvim",
  },
  {
    "LazyVim/LazyVim",
    opts = {
      colorscheme = "catppuccin-frappe",
    },
  },
}
