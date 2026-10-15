import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // Honor the port assigned by the preview harness (falls back to 3000 locally).
  server: {
    host: true,
    port: Number(process.env.PORT) || 3000,
    // Dev only: serve the API on the same origin as the page (like production).
    // The session cookie then belongs to whichever host the page was opened on,
    // so localhost:3000 and 127.0.0.1:3000 can hold two different logins at once.
    proxy: { "/api": "http://localhost:4000" },
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
});
