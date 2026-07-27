import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: '.',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true
  },
  server: {
    host: '127.0.0.1',
    port: 4311,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4312',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (request) => {
            if (request.getHeader('origin')) request.setHeader('origin', 'http://127.0.0.1:4312');
          });
        }
      }
    }
  }
});
