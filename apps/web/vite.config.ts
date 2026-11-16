import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true, // accesibil și din rețea / prin tunel
    allowedHosts: true, // permite domeniile de tunel (ngrok, Cloudflare)
    proxy: {
      // Tot ce începe cu /api merge la backend.
      "/api": "http://localhost:3001",
    },
  },
});
