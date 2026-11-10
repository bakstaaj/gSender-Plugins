import gsenderPlugin from '@sienci/gsender-plugin-sdk/vite';
import { defineConfig } from 'vite';

export default defineConfig({
    plugins: [gsenderPlugin()],
    base: './',
    build: {
        outDir: 'ui',
        // Avoid deleting existing output in a OneDrive-synced install folder.
        emptyOutDir: false,
        rollupOptions: { external: ['@sienci/gsender-plugin-sdk'] },
    },
});
