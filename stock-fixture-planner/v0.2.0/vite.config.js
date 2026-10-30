import { defineConfig } from 'vite';
import gsenderPlugin from '@sienci/gsender-plugin-sdk/vite';

export default defineConfig({ plugins: [gsenderPlugin()], base: './', build: { outDir: 'ui', emptyOutDir: true } });
