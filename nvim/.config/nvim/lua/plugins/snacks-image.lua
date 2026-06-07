return {
  {
    "folke/snacks.nvim",
    opts = {
      image = {
        enabled = true,
        -- Snacks image uses the Kitty graphics protocol. Keep this false unless
        -- your terminal supports it but detection fails; then start nvim with:
        --   SNACKS_IMAGE_FORCE=1 nvim
        force = vim.env.SNACKS_IMAGE_FORCE == "1",
        doc = {
          enabled = true,
          inline = true,
          float = true,
          max_width = 80,
          max_height = 40,
        },
      },
    },
    keys = {
      { "<leader>ui", function() Snacks.image.hover() end, desc = "Image Hover" },
    },
  },
}
