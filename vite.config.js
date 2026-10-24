import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// base './' — відносні шляхи, щоб застосунок працював і з кореня сайту, і з підпапки
// (наприклад, volanderbo-stack.github.io/Reader-/).
// HTTPS=1 вмикає https із самопідписаним сертифікатом: камера в браузері телефона
// працює лише через https (або localhost).
export default defineConfig({
  base: './',
  plugins: process.env.HTTPS ? [basicSsl()] : [],
  build: { chunkSizeWarningLimit: 1000 },
});
