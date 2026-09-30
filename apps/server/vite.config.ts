import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

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
                    entryFileNames: '[name].js',
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
        ssr: {
            external: Object.keys(nativeModulePaths),
            noExternal: true as const,
        },
    };
});
