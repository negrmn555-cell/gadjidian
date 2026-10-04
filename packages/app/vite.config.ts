import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg','push-events.js'],
      manifest: {
        name: 'Obsidian Relay',
        short_name: 'Relay',
        description: 'Ваше хранилище Obsidian — из любого браузера',
        lang: 'ru',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        background_color: '#f7f7f5',
        theme_color: '#f7f7f5',
        icons: [
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
        share_target: {
          action: '/share',
          method: 'GET',
          params: { title: 'title', text: 'text', url: 'url' },
        },
      },
      workbox: {
        importScripts: ['/push-events.js'],
        cacheId: 'obsidian-relay-v2',
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/assets\//],
        runtimeCaching: [{ urlPattern: /^\/api\//, handler: 'NetworkOnly' }],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8080', ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
