import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  base: '/demo-dashboard/',
  plugins: [react()],
  server: {
    watch: {
      ignored: ['**/public/velocity_data/**']
    }
  }
})
