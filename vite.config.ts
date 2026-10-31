import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    sourcemap: false,
    minify: "esbuild",
    target: "chrome120",
  },
  esbuild: {
    drop: ["console", "debugger"],
    legalComments: "none",
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    watch: {
      ignored: ["**/release/**", "**/release-secure/**", "**/artifacts/**"],
    },
  },
});
