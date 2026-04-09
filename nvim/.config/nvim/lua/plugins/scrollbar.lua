-- Shows gitsigns and other markers in the scrollbar
return {
  {
    "lewis6991/satellite.nvim",
    event = "VeryLazy",
    opts = {
      current_only = false,
      winblend = 50,
      handlers = {
        cursor = { enable = true },
        search = { enable = true },
        gitsigns = { enable = true },
        marks = { enable = true },
      },
    },
  },
}
