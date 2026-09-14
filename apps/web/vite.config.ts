import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "../..", "");
  const additionalAllowedHost = env.VITE_ADDITIONAL_ALLOWED_HOST?.trim();

  return {
    plugins: [
      react(),
      VitePWA({
        registerType: "autoUpdate",
        injectRegister: "auto",
        includeAssets: [
          "icons/icon-192.png",
          "icons/icon-512.png",
          "icons/maskable-512.png",
          "manifest.webmanifest",
        ],
        manifest: false,
        devOptions: {
          enabled: false,
        },
        workbox: {
          globPatterns: ["**/*.{js,css,html,ico,png,svg,webmanifest}"],
          navigateFallback: "index.html",
          navigateFallbackDenylist: [/^\/api\//],
          runtimeCaching: [
            {
              urlPattern: ({ url }) => url.pathname.startsWith("/api/"),
              handler: "NetworkOnly",
            },
            {
              urlPattern: ({ request }) =>
                request.mode === "navigate" || request.destination === "document",
              handler: "NetworkFirst",
              options: {
                cacheName: "html-shell",
                networkTimeoutSeconds: 3,
              },
            },
            {
              urlPattern: ({ request }) =>
                request.destination === "script" ||
                request.destination === "style" ||
                request.destination === "worker",
              handler: "CacheFirst",
              options: {
                cacheName: "hashed-assets",
                expiration: {
                  maxEntries: 64,
                  maxAgeSeconds: 60 * 60 * 24 * 365,
                },
              },
            },
          ],
        },
      }),
    ],
    server: {
      port: 5173,
      proxy: {
        "/api": "http://127.0.0.1:3001",
      },
    },
    preview: {
      port: 4173,
      ...(additionalAllowedHost === undefined || additionalAllowedHost === ""
        ? {}
        : { allowedHosts: [additionalAllowedHost] }),
      proxy: {
        "/api": "http://127.0.0.1:3001",
      },
    },
    test: {
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      exclude: ["**/node_modules/**", "**/dist/**", "**/tests/**"],
    },
  };
});
