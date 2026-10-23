import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `npm run dev` serves the dashboard on :5173 and forwards API calls to a gateway on :8080.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:8080' } },
});
