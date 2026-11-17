import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Porturile se pot schimba din mediu (WEB_PORT, SERVER_PORT), ca să poată rula două copii în paralel.
const webPort = Number(process.env.WEB_PORT ?? 5173);
const serverPort = Number(process.env.SERVER_PORT ?? 3001);

export default defineConfig({
  plugins: [react()],
  server: {
    port: webPort,
    host: true, // accesibil și din rețea / prin tunel
    allowedHosts: true, // permite domeniile de tunel (ngrok, Cloudflare)
    proxy: {
      // Tot ce începe cu /api merge la backend.
      // 127.0.0.1, nu „localhost”: pe unele PC-uri localhost înseamnă întâi IPv6 (::1), unde cererile rămân agățate.
      "/api": `http://127.0.0.1:${serverPort}`,
    },
  },
});
