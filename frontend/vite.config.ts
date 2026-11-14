/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Le backend FastAPI (analyse du tracé) tourne sur :8000 en développement.
  server: { proxy: { '/api': 'http://localhost:8000' } },
  test: { environment: 'node' },
});
