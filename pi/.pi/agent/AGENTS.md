# Global Pi Agent Instructions

## Image URLs

A global pi extension named `download_image_url` is installed. When the user provides an HTTP(S) URL that points to an image and asks you to view, inspect, analyze, or otherwise use the image, call `download_image_url` first.

The tool downloads the image with `curl` into `/tmp/` and returns the local file path. After it returns, use the `read` tool on that local path to see the image.
