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

import { rendererReactCompilerOptions } from './scripts/react-compiler-options';
import { resolveSourceMapFlavor, shouldIncludeSourceMaps } from './scripts/source-map-flavor';

/**
 * Opt-in bundle analysis: `CAXRI_BUNDLE_ANALYZE=1 bun run build:desktop` writes an interactive HTML + JSON report per
 * process (main/preload/renderer) under `.cache/bundle-analysis/`.
 */
const isBundleAnalysisEnabled = process.env.CAXRI_BUNDLE_ANALYZE === '1';
/**
 * Ordinary builds remain debuggable by default. The public release pipeline opts into `omit` for its second artifact;
 * the shared strict parser keeps Main, Preload, Renderer, and Server on one flavor.
 */
const SOURCE_MAP_FLAVOR = resolveSourceMapFlavor();
const IS_SOURCEMAP_ENABLED = shouldIncludeSourceMaps(SOURCE_MAP_FLAVOR);
const isReactProfilingEnabled = process.env.CAXRI_REACT_PROFILING === '1';
/**
 * Opt-in react-scan render counting for development audits (`CAXRI_REACT_SCAN=1`). The boot module must be the first
 * import of the Renderer entry: react-scan installs the React DevTools hook on import, and react-dom only registers
 * with a hook that already exists when it evaluates, so injecting react-scan over CDP after load measures nothing.
 */
const isReactScanEnabled = process.env.CAXRI_REACT_SCAN === '1';
const reactScanBootModuleId = 'virtual:caxri-react-scan-boot';
const resolvedReactScanBootModuleId = `\0${reactScanBootModuleId}`;

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
    const reactCompiler = await babel({
        presets: [reactCompilerPreset(rendererReactCompilerOptions)],
    });
    const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as {
        version: string;
    };
    const gitCommit = await resolveGitCommit();

    return {
        main: {
            /**
             * Stamps every Main/Runtime build with the package version and commit it was built from, so logs and
             * diagnostics exports can be correlated to a specific build. See apps/desktop/src/main/global.d.ts for the
             * corresponding ambient type declarations.
             */
            define: {
                __CAXRI_VERSION__: JSON.stringify(packageJson.version),
                __CAXRI_COMMIT__: JSON.stringify(gitCommit),
                __CAXRI_SOURCE_MAP_FLAVOR__: JSON.stringify(SOURCE_MAP_FLAVOR),
            },
            build: {
                sourcemap: IS_SOURCEMAP_ENABLED,
                /**
                 * Externalizes only root `dependencies`, which is intentionally empty: every Desktop package, including
                 * the `ws` transport, lives in `devDependencies` so electron-vite bundles it into Main.
                 */
                externalizeDeps: true,
                // Knip's electron-vite plugin only discovers build entries under `rollupOptions.input`;
                // renaming to the non-deprecated `rolldownOptions` breaks that discovery and makes knip
                // report the whole process-explorer entry chain as unused. Keep the deprecated name until
                // knip understands `rolldownOptions`.
                // oxlint-disable-next-line typescript/no-deprecated -- see above: knip compatibility
                rollupOptions: {
                    input: {
                        index: resolve('apps/desktop/src/main/bootstrap.ts'),
                    },
                    output: {
                        /**
                         * Keeps the Main graph chunk beside the bootstrap entry: Main resolves `preload/` and the
                         * Renderer relative to its own `import.meta.url`.
                         */
                        chunkFileNames: '[name]-[hash].js',
                    },
                },
            },
            plugins: bundleAnalysisPlugins('main'),
        },
        preload: {
            build: {
                sourcemap: IS_SOURCEMAP_ENABLED,
                externalizeDeps: true,
                // Knip's electron-vite plugin only discovers build entries under `rollupOptions.input`;
                // renaming to the non-deprecated `rolldownOptions` breaks that discovery and makes knip
                // report the whole process-explorer entry chain as unused. Keep the deprecated name until
                // knip understands `rolldownOptions`.
                // oxlint-disable-next-line typescript/no-deprecated -- see above: knip compatibility
                rollupOptions: {
                    input: {
                        'index': resolve('apps/desktop/src/preload/index.ts'),
                        'process-explorer': resolve('apps/desktop/src/preload/process-explorer.ts'),
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
            root: resolve('apps/desktop/src/renderer'),
            define: {
                __CAXRI_REACT_PROFILING__: JSON.stringify(isReactProfilingEnabled),
            },
            /**
             * Ships the full vscode-icons SVG set (`icons/*.svg` + `manifest.json`) by verbatim copy into the build
             * output and via the dev server. `import.meta.glob` cannot reach into `node_modules` in production builds
             * (Vite ignores it there), so the Renderer references these files by stable relative URL instead
             * (`apps/desktop/src/renderer/src/icons/files/file-icon-assets.ts`).
             */
            publicDir: resolve('apps/desktop/node_modules/@yutengjing/vscode-icons/assets'),
            /**
             * Pdf.js's binary CMaps and Type 1 standard fonts, which the PDF preview imports with `?inline`
             * (`features/preview/pdf-binary-data.ts`). Vite inlines only file types it knows as assets; any other
             * `?inline` import is loaded as a module and fails.
             */
            assetsInclude: ['**/*.bcmap', '**/*.pfb', '**/*.wasm'],
            build: {
                sourcemap: IS_SOURCEMAP_ENABLED,
                /**
                 * Minified, but identifiers keep their names (`mangle: false` below): stack traces in Renderer logs and
                 * React component names stay readable without a map lookup, while whitespace removal and compression
                 * take the shipped Renderer from ≈ 56 MiB to ≈ 39 MiB (docs/bundle-size.md). Workers (Monaco language
                 * services, pdf.js) are third-party only and use the fully mangled default.
                 */
                minify: true,
                // Knip's electron-vite plugin only discovers build entries under `rollupOptions.input`;
                // renaming to the non-deprecated `rolldownOptions` breaks that discovery and makes knip
                // report the whole process-explorer entry chain as unused. Keep the deprecated name until
                // knip understands `rolldownOptions`.
                // oxlint-disable-next-line typescript/no-deprecated -- see above: knip compatibility
                rollupOptions: {
                    output: {
                        minify: { mangle: false },
                        // Minification would otherwise drop the `@license` and `/*!` notices of bundled packages.
                        comments: { legal: true },
                    },
                    input: {
                        'index': resolve('apps/desktop/src/renderer/index.html'),
                        'agent-commander': resolve(
                            'apps/desktop/src/renderer/agent-commander.html',
                        ),
                        'benchmark': resolve('apps/desktop/src/renderer/benchmark.html'),
                        'process-explorer': resolve(
                            'apps/desktop/src/renderer/process-explorer.html',
                        ),
                    },
                },
            },
            resolve: {
                alias: {
                    '@': resolve('apps/desktop/src/renderer/src'),
                    '@desktop-shared': resolve('apps/desktop/src/shared'),
                    ...(isReactProfilingEnabled && {
                        'react-dom/client': resolve('node_modules/react-dom/profiling.js'),
                    }),
                },
            },
            plugins: [
                {
                    name: 'caxri-react-scan-boot',
                    resolveId(id: string) {
                        return id === reactScanBootModuleId
                            ? resolvedReactScanBootModuleId
                            : undefined;
                    },
                    load(id: string) {
                        if (id !== resolvedReactScanBootModuleId) return;
                        return isReactScanEnabled
                            ? [
                                  "import { scan, setOptions } from 'react-scan';",
                                  'scan({ enabled: false, showToolbar: false });',
                                  'globalThis.__CAXRI_REACT_SCAN__ = { scan, setOptions };',
                              ].join('\n')
                            : 'export {};';
                    },
                },
                react(),
                reactCompiler,
                tailwindcss(),
                {
                    name: 'caxri-renderer-csp',
                    transformIndexHtml: {
                        order: 'pre',
                        handler(html: string) {
                            const connectSource =
                                command === 'serve' ? "'self' ws://localhost:*" : "'self'";
                            return html.replace('__CAXRI_CONNECT_SRC__', () => connectSource);
                        },
                    },
                },
                ...bundleAnalysisPlugins('renderer'),
            ],
        },
    } satisfies UserConfig;
});
