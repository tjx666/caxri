import { join, resolve } from 'node:path';

import type { BuildFreshnessOptions } from '../../src/shared/node/build-freshness.ts';
import { createBuildFreshnessGuard } from '../../src/shared/node/build-freshness.ts';

const projectRoot = resolve(import.meta.dirname, '../..');
const staleBuildMessage = 'Build output is stale — run "bun run build" before running e2e specs.';
const watchedBuildInputExtensions = new Set([
    '.css',
    '.html',
    '.json',
    '.png',
    '.svg',
    '.ts',
    '.tsx',
    '.ttf',
    '.woff',
    '.woff2',
]);

/**
 * Declares the coarse source and output boundaries consumed by the Desktop build so the contract can be exercised
 * without launching Electron. Workspace packages stay explicit because their sources live outside the root `src`.
 */
export function createE2EBuildFreshnessOptions(root: string): BuildFreshnessOptions {
    return {
        inputPaths: [
            join(root, 'src'),
            join(root, 'electron.vite.config.ts'),
            join(root, 'extensions', 'fixture', 'package.json'),
            join(root, 'extensions', 'fixture', 'media'),
            join(root, 'extensions', 'fixture', 'src'),
            join(root, 'extensions', 'fixture', 'tsconfig.json'),
            join(root, 'extensions', 'git', 'package.json'),
            join(root, 'extensions', 'git', 'src'),
            join(root, 'extensions', 'git', 'tsconfig.json'),
            join(root, 'extensions', 'status', 'package.json'),
            join(root, 'extensions', 'status', 'src'),
            join(root, 'extensions', 'status', 'tsconfig.json'),
            join(root, 'extensions', 'tsconfig.base.json'),
            join(root, 'package.json'),
            join(root, 'packages', 'agent-skills', 'package.json'),
            join(root, 'packages', 'agent-skills', 'scripts'),
            join(root, 'packages', 'agent-skills', 'src'),
            join(root, 'packages', 'agent-skills', 'tsconfig.build.json'),
            join(root, 'packages', 'agent-skills', 'tsconfig.json'),
            join(root, 'packages', 'cli', 'package.json'),
            join(root, 'packages', 'cli', 'scripts'),
            join(root, 'packages', 'cli', 'src'),
            join(root, 'packages', 'cli', 'tsconfig.build.json'),
            join(root, 'packages', 'cli', 'tsconfig.json'),
            join(root, 'packages', 'client', 'package.json'),
            join(root, 'packages', 'client', 'src'),
            join(root, 'packages', 'client', 'tsconfig.build.json'),
            join(root, 'packages', 'client', 'tsconfig.json'),
            join(root, 'packages', 'extension-api', 'package.json'),
            join(root, 'packages', 'extension-api', 'src'),
            join(root, 'packages', 'extension-api', 'tsconfig.build.json'),
            join(root, 'packages', 'extension-api', 'tsconfig.json'),
            join(root, 'packages', 'protocol', 'package.json'),
            join(root, 'packages', 'protocol', 'src'),
            join(root, 'packages', 'protocol', 'tsconfig.build.json'),
            join(root, 'packages', 'protocol', 'tsconfig.json'),
            join(root, 'packages', 'utils', 'package.json'),
            join(root, 'packages', 'utils', 'src'),
            join(root, 'packages', 'utils', 'tsconfig.json'),
            join(root, 'pnpm-lock.yaml'),
            join(root, 'pnpm-workspace.yaml'),
            join(root, 'scripts', 'build-extension.ts'),
            join(root, 'scripts', 'extension-bundle-contract.ts'),
            join(root, 'skills', 'caxri-cli'),
            join(root, 'tsconfig.node.json'),
            join(root, 'tsconfig.web.json'),
        ],
        outputPaths: [
            join(root, 'extensions', 'fixture', 'dist', 'extension.js'),
            join(root, 'extensions', 'git', 'dist', 'extension.js'),
            join(root, 'extensions', 'status', 'dist', 'extension.js'),
            join(root, 'out', 'main', 'index.js'),
            join(root, 'out', 'main', 'host.js'),
            join(root, 'out', 'main', 'extension-host.js'),
            join(root, 'out', 'main', 'runtime.js'),
            join(root, 'out', 'preload', 'index.cjs'),
            join(root, 'out', 'preload', 'process-explorer.cjs'),
            join(root, 'out', 'renderer', 'index.html'),
            join(root, 'out', 'renderer', 'process-explorer.html'),
            join(root, 'packages', 'cli', 'dist', 'caxri.cjs'),
        ],
        staleMessage: staleBuildMessage,
        watchedDirectoryExtensions: watchedBuildInputExtensions,
    };
}

/**
 * Guards direct Playwright launches against stale desktop and bundled-extension output. The focused check entrypoint
 * builds first, but direct spec execution can otherwise launch a previously generated `out/main/index.js`.
 */
const buildFreshnessGuard = createBuildFreshnessGuard(createE2EBuildFreshnessOptions(projectRoot));

export async function assertE2EBuildIsFresh(): Promise<void> {
    await buildFreshnessGuard.assertFresh();
}
