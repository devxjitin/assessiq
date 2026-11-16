import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC is used so NestJS decorator metadata works under vitest.
export default defineConfig({
  test: { include: ['src/**/*.test.ts'] },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
