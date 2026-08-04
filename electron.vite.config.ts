import { resolve } from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

export default defineConfig(({ command }) => ({
    main: {
        build: {
            externalizeDeps: true,
            rollupOptions: {
                input: {
                    index: resolve('src/main/index.ts'),
                    runtime: resolve('src/runtime/index.ts'),
                },
            },
        },
    },
    preload: {
        build: {
            externalizeDeps: true,
            rollupOptions: {
                input: resolve('src/preload/index.ts'),
                output: {
                    format: 'cjs',
                    entryFileNames: '[name].cjs',
                },
            },
        },
    },
    renderer: {
        resolve: {
            alias: {
                '@': resolve('src/renderer/src'),
                '@shared': resolve('src/shared'),
            },
        },
        plugins: [
            react(),
            tailwindcss(),
            {
                name: 'caxri-renderer-csp',
                transformIndexHtml(html) {
                    const connectSource =
                        command === 'serve' ? "'self' ws://localhost:*" : "'self'";
                    return html.replace('__CAXRI_CONNECT_SRC__', connectSource);
                },
            },
        ],
    },
}));
