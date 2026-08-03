import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src/web",
  plugins: [react()],
  server: {
    port: 4316,
    proxy: {
      "/api": "http://127.0.0.1:4317",
    },
  },
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
});
