import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import type { UserConfig } from 'electron-vite';
import { defineConfig } from 'electron-vite';

const execFileAsync = promisify(execFile);

/**
Best-effort short commit hash; packaged builds outside a Git checkout fall back to 'unknown'.
 */
async function resolveGitCommit(): Promise<string> {
    try {
        const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], {
            cwd: resolve('.'),
            encoding: 'utf8',
        });
        return stdout.trim();
    } catch {
        return 'unknown';
    }
}

export default defineConfig(async ({ command }) => {
    /**
     * `@rolldown/plugin-babel` returns a Vite-supported Promise, but electron-vite 6 beta deep-clones
     * each process config before Vite resolves async plugins. Resolve it here so the official React
     * Compiler preset reaches only the Renderer pipeline as a plain plugin object.
     */
    const reactCompiler = await babel({ presets: [reactCompilerPreset()] });
    const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as {
        version: string;
    };
    const gitCommit = await resolveGitCommit();

    return {
        main: {
            /**
             * Stamps every Main/Runtime build with the package version and commit it was built from, so
             * logs and diagnostics exports can be correlated to a specific build. See src/main/global.d.ts
             * for the corresponding ambient type declarations.
             */
            define: {
                __CAXRI_VERSION__: JSON.stringify(packageJson.version),
                __CAXRI_COMMIT__: JSON.stringify(gitCommit),
            },
            build: {
                externalizeDeps: { exclude: ['@caxri/cli', '@caxri/protocol'] },
                rollupOptions: {
                    input: {
                        host: resolve('src/host/process.ts'),
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
                    input: {
                        'index': resolve('src/preload/index.ts'),
                        'process-explorer': resolve('src/preload/process-explorer.ts'),
                    },
                    output: {
                        format: 'cjs',
                        entryFileNames: '[name].cjs',
                    },
                },
            },
        },
        renderer: {
            build: {
                rollupOptions: {
                    input: {
                        'index': resolve('src/renderer/index.html'),
                        'process-explorer': resolve('src/renderer/process-explorer.html'),
                    },
                },
            },
            resolve: {
                alias: {
                    '@': resolve('src/renderer/src'),
                    '@shared': resolve('src/shared'),
                },
            },
            plugins: [
                react(),
                reactCompiler,
                tailwindcss(),
                {
                    name: 'caxri-renderer-csp',
                    transformIndexHtml(html: string) {
                        const connectSource =
                            command === 'serve' ? "'self' ws://localhost:*" : "'self'";
                        return html.replace('__CAXRI_CONNECT_SRC__', () => connectSource);
                    },
                },
            ],
        },
    } satisfies UserConfig;
});
