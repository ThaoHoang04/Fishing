import { defineConfig } from 'vite';

// In dev the game server (npm run dev:server) runs on :3001; proxy Socket.IO so the client stays same-origin.
export default defineConfig({
  server: {
    proxy: { '/socket.io': { target: 'http://localhost:3001', ws: true } },
  },
  build: {
    // Phaser is ~1.7 MB and never changes between our releases: its own chunk stays cached when only game code changes.
    rollupOptions: { output: { manualChunks: { phaser: ['phaser'] } } },
    chunkSizeWarningLimit: 1900,
  },
});
