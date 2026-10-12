import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import type { Plugin } from 'vite';
import { defineConfig } from 'vite';

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');
const nativeModulePaths: Record<string, string> = {
    '@parcel/watcher': '../native/node_modules/@parcel/watcher/index.js',
    'better-sqlite3': '../native/node_modules/better-sqlite3/lib/index.js',
    'node-pty': '../native/node_modules/node-pty/lib/index.js',
};

async function resolveGitCommit(): Promise<string> {
    try {
        const { stdout } = await execFileAsync('git', ['rev-parse', '--short=8', 'HEAD'], {
            cwd: root,
            encoding: 'utf8',
        });
        return stdout.trim();
    } catch {
        return 'unknown';
    }
}

/**
 * Fails the build when an emitted chunk still contains a non-ASCII character. `codegen.asciiOnly` escapes literals and
 * identifiers but deliberately leaves tagged template quasis raw (their raw text is observable), so a non-ASCII
 * character there would silently make V8 store that whole chunk as two-byte source again. Escape it in the source
 * instead (for example `\u2026` inside a `String.raw` script).
 */
function asciiOnlyBundles(): Plugin {
    return {
        name: 'caxri-ascii-only-bundles',
        generateBundle(_options, bundle) {
            for (const chunk of Object.values(bundle)) {
                if (chunk.type !== 'chunk') continue;
                const index = chunk.code.search(/\P{ASCII}/u);
                if (index === -1) continue;
                const line = chunk.code.slice(0, index).split('\n').length;
                const character = chunk.code.codePointAt(index)!.toString(16).toUpperCase();
                throw new Error(
                    `${chunk.fileName}:${line} contains non-ASCII U+${character}; escape it in the source so Server bundles stay one-byte in V8`,
                );
            }
        },
    };
}

export default defineConfig(async () => {
    const workspaceManifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as {
        version: string;
    };
    return {
        build: {
            emptyOutDir: true,
            minify: false,
            outDir: resolve(import.meta.dirname, 'dist/bundles'),
            rolldownOptions: {
                external: Object.keys(nativeModulePaths),
                input: {
                    'agent-launcher': resolve(
                        import.meta.dirname,
                        'src/terminal-host/agent-launcher/process.ts',
                    ),
                    'extension-host': resolve(import.meta.dirname, 'src/extension-host/process.ts'),
                    'project-search-worker': resolve(
                        import.meta.dirname,
                        'src/domains/files/project-search-worker.ts',
                    ),
                    'server-core': resolve(import.meta.dirname, 'src/core/bootstrap.ts'),
                    'terminal-host': resolve(import.meta.dirname, 'src/terminal-host/process.ts'),
                },
                output: {
                    /**
                     * Native package rewrites are relative to every emitted bundle. Keeping shared chunks beside the
                     * entrypoints makes the standalone artifact resolve the same `../native` boundary after Core and
                     * domain services share one bundle graph.
                     */
                    chunkFileNames: '[name]-[hash].js',
                    /**
                     * Comments add bytes to every module source V8 keeps resident, and most non-ASCII characters in a
                     * bundle come from them. Source maps keep the original comments for debugging.
                     */
                    comments: false,
                    entryFileNames: '[name].js',
                    /**
                     * Whitespace-only, ASCII-only codegen without compression or mangling. V8 retains every module's
                     * source text for `Function.prototype.toString` and lazy compilation, and a single character
                     * outside Latin-1 makes it store the whole source as two-byte UTF-16, doubling that resident cost.
                     * Escaping non-ASCII literals as `\uXXXX` keeps every chunk one-byte, and dropping whitespace
                     * shrinks the retained text further. Identifiers stay unmangled so stack traces and logs keep their
                     * names; Rolldown regenerates the source maps for this output. Measured on Server Core at idle:
                     * footprint -15 MB, V8 external -6 MB, bundle JS -30%.
                     */
                    minify: {
                        codegen: {
                            asciiOnly: true,
                            legalComments: 'none' as const,
                            removeWhitespace: true,
                        },
                        compress: false,
                        mangle: false,
                    },
                    paths: nativeModulePaths,
                },
            },
            // Source maps ship in every build for the same reason the Desktop's do; see electron.vite.config.ts.
            sourcemap: true,
            ssr: true,
            target: 'node24',
        },
        define: {
            __CAXRI_COMMIT__: JSON.stringify(await resolveGitCommit()),
            __CAXRI_VERSION__: JSON.stringify(workspaceManifest.version),
        },
        plugins: [asciiOnlyBundles()],
        ssr: {
            external: Object.keys(nativeModulePaths),
            noExternal: true as const,
        },
    };
});
