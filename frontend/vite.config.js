import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // The /api proxy only exists when a backend address is actually given:
    //
    //   VITE_API_TARGET=http://localhost:8000 npm run dev
    //
    // With no backend configured there is nothing to forward to — proxying
    // anyway just fills the terminal with ECONNREFUSED noise every poll.
    // Unproxied /api requests get the SPA page back, which the api layer
    // treats as "no backend" and falls back to the mock data.
    proxy: process.env.VITE_API_TARGET
      ? {
          '/api': {
            target: process.env.VITE_API_TARGET,
            changeOrigin: true,
          },
        }
      : undefined,
  },
})
