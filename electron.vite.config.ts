import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
    version: string;
};

/** Best-effort short commit hash; packaged builds outside a Git checkout fall back to 'unknown'. */
function resolveGitCommit(): string {
    try {
        return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
            cwd: resolve('.'),
            encoding: 'utf8',
        }).trim();
    } catch {
        return 'unknown';
    }
}

export default defineConfig(({ command }) => ({
    main: {
        /**
         * Stamps every Main/Runtime build with the package version and commit it was built from, so
         * logs and diagnostics exports can be correlated to a specific build. See src/main/global.d.ts
         * for the corresponding ambient type declarations.
         */
        define: {
            __CAXRI_VERSION__: JSON.stringify(packageJson.version),
            __CAXRI_COMMIT__: JSON.stringify(resolveGitCommit()),
        },
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
