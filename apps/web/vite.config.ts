import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In dev the API runs separately; proxy so cookies stay same-origin.
    proxy: { '/api': 'http://localhost:3000' },
  },
});
