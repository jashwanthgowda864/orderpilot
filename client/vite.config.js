import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The client never holds secrets: it only talks to /api on the OrderPilot server.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:4000' } },
  envPrefix: 'ORDERPILOT_PUBLIC_',
});
