import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// HTTPS=1 вмикає https із самопідписаним сертифікатом: камера в браузері телефона
// працює лише через https (або localhost).
export default defineConfig({
  plugins: process.env.HTTPS ? [basicSsl()] : [],
  build: { chunkSizeWarningLimit: 1000 },
});
