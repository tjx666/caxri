import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import type { UserConfig } from 'electron-vite';
import { defineConfig } from 'electron-vite';
import Sonda from 'sonda/vite';
import type { PluginOption } from 'vite';

/**
 * Opt-in bundle analysis: `CAXRI_BUNDLE_ANALYZE=1 bun run build:desktop` writes an interactive HTML + JSON report per
 * process (main/preload/renderer) under `.cache/bundle-analysis/`. Sonda needs source maps to attribute minified bytes
 * to packages, so the flag also turns them on.
 */
const isBundleAnalysisEnabled = process.env.CAXRI_BUNDLE_ANALYZE === '1';

function bundleAnalysisPlugins(reportName: string): PluginOption[] {
    if (!isBundleAnalysisEnabled) return [];
    return [
        Sonda({
            filename: `${reportName}.[index]`,
            format: ['html', 'json'],
            outputDir: '.cache/bundle-analysis',
            deep: true,
            open: false,
        }),
    ];
}

const execFileAsync = promisify(execFile);

/**
 * Best-effort fixed-width commit marker; packaged builds outside a Git checkout fall back to 'unknown'.
 */
async function resolveGitCommit(): Promise<string> {
    try {
        const { stdout } = await execFileAsync('git', ['rev-parse', '--short=8', 'HEAD'], {
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
     * `@rolldown/plugin-babel` returns a Vite-supported Promise, but electron-vite 6 beta deep-clones each process
     * config before Vite resolves async plugins. Resolve it here so the official React Compiler preset reaches only the
     * Renderer pipeline as a plain plugin object.
     */
    const reactCompiler = await babel({ presets: [reactCompilerPreset()] });
    const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as {
        version: string;
    };
    const gitCommit = await resolveGitCommit();

    return {
        main: {
            /**
             * Stamps every Main/Runtime build with the package version and commit it was built from, so logs and
             * diagnostics exports can be correlated to a specific build. See src/main/global.d.ts for the corresponding
             * ambient type declarations.
             */
            define: {
                __CAXRI_VERSION__: JSON.stringify(packageJson.version),
                __CAXRI_COMMIT__: JSON.stringify(gitCommit),
            },
            build: {
                sourcemap: isBundleAnalysisEnabled,
                /**
                 * Native modules and the shared `ws` transport stay external and are packaged from `dependencies`;
                 * every other pure-JS dependency lives in `devDependencies` so electron-vite bundles it.
                 */
                externalizeDeps: true,
                // Knip's electron-vite plugin only discovers build entries under `rollupOptions.input`;
                // renaming to the non-deprecated `rolldownOptions` breaks that discovery and makes knip
                // report the whole process-explorer entry chain as unused. Keep the deprecated name until
                // knip understands `rolldownOptions`.
                // oxlint-disable-next-line typescript/no-deprecated -- see above: knip compatibility
                rollupOptions: {
                    input: {
                        'extension-host': resolve('src/extension-host/process.ts'),
                        'host': resolve('src/host/process.ts'),
                        'index': resolve('src/main/index.ts'),
                        'runtime': resolve('src/runtime/index.ts'),
                    },
                },
            },
            plugins: bundleAnalysisPlugins('main'),
        },
        preload: {
            build: {
                sourcemap: isBundleAnalysisEnabled,
                externalizeDeps: true,
                // Knip's electron-vite plugin only discovers build entries under `rollupOptions.input`;
                // renaming to the non-deprecated `rolldownOptions` breaks that discovery and makes knip
                // report the whole process-explorer entry chain as unused. Keep the deprecated name until
                // knip understands `rolldownOptions`.
                // oxlint-disable-next-line typescript/no-deprecated -- see above: knip compatibility
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
            plugins: bundleAnalysisPlugins('preload'),
        },
        renderer: {
            /**
             * Ships the full vscode-icons SVG set (`icons/*.svg` + `manifest.json`) by verbatim copy into the build
             * output and via the dev server. `import.meta.glob` cannot reach into `node_modules` in production builds
             * (Vite ignores it there), so the Renderer references these files by stable relative URL instead
             * (`src/renderer/src/icons/files/file-icon-assets.ts`).
             */
            publicDir: resolve('node_modules/@yutengjing/vscode-icons/assets'),
            build: {
                sourcemap: isBundleAnalysisEnabled,
                // Knip's electron-vite plugin only discovers build entries under `rollupOptions.input`;
                // renaming to the non-deprecated `rolldownOptions` breaks that discovery and makes knip
                // report the whole process-explorer entry chain as unused. Keep the deprecated name until
                // knip understands `rolldownOptions`.
                // oxlint-disable-next-line typescript/no-deprecated -- see above: knip compatibility
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
                ...bundleAnalysisPlugins('renderer'),
            ],
        },
    } satisfies UserConfig;
});
