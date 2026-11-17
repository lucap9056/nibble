import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const adminTarget = process.env.NIBBLE_ADMIN_URL ?? "http://127.0.0.1:8081";

export default defineConfig({
  base: "./",
  plugins: [svelte(), viteSingleFile()],
  server: {
    proxy: {
      "/api": adminTarget,
    },
  },
});
