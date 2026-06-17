import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Proxy /api -> backend FastAPI (uvicorn :8077) để khỏi lo CORS.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    proxy: {
      '/api': 'http://localhost:8077',
    },
  },
})
