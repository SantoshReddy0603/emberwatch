import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    // Native file events do not reach WSL from Windows drives; poll there instead.
    watch: process.platform === 'linux' && process.cwd().startsWith('/mnt/')
      ? { usePolling: true, interval: 300 }
      : undefined,
    proxy: {
      '/api': 'http://127.0.0.1:4000',
      '/socket.io': { target: 'http://127.0.0.1:4000', ws: true },
    },
  },
  test: { environment: 'node' },
});
