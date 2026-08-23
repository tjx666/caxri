import { join, resolve } from 'node:path';

import { createBuildFreshnessGuard } from '../../src/shared/node/build-freshness.ts';

const projectRoot = resolve(import.meta.dirname, '../..');
const staleBuildMessage = 'Build output is stale — run "bun run build" before running e2e specs.';
const buildInputPaths = [
    join(projectRoot, 'src'),
    join(projectRoot, 'electron.vite.config.ts'),
    join(projectRoot, 'extensions', 'fixture', 'package.json'),
    join(projectRoot, 'extensions', 'fixture', 'src'),
    join(projectRoot, 'extensions', 'fixture', 'tsconfig.json'),
    join(projectRoot, 'extensions', 'status', 'package.json'),
    join(projectRoot, 'extensions', 'status', 'src'),
    join(projectRoot, 'extensions', 'status', 'tsconfig.json'),
    join(projectRoot, 'extensions', 'tsconfig.base.json'),
    join(projectRoot, 'package.json'),
    join(projectRoot, 'packages', 'cli', 'package.json'),
    join(projectRoot, 'packages', 'cli', 'scripts'),
    join(projectRoot, 'packages', 'cli', 'src'),
    join(projectRoot, 'packages', 'cli', 'tsconfig.build.json'),
    join(projectRoot, 'packages', 'cli', 'tsconfig.json'),
    join(projectRoot, 'packages', 'protocol', 'package.json'),
    join(projectRoot, 'packages', 'protocol', 'src'),
    join(projectRoot, 'packages', 'protocol', 'tsconfig.build.json'),
    join(projectRoot, 'packages', 'protocol', 'tsconfig.json'),
    join(projectRoot, 'pnpm-lock.yaml'),
    join(projectRoot, 'pnpm-workspace.yaml'),
    join(projectRoot, 'scripts', 'build-extension.ts'),
    join(projectRoot, 'scripts', 'extension-bundle-contract.ts'),
    join(projectRoot, 'tsconfig.node.json'),
    join(projectRoot, 'tsconfig.web.json'),
];
const buildOutputPaths = [
    join(projectRoot, 'extensions', 'fixture', 'dist', 'extension.js'),
    join(projectRoot, 'extensions', 'status', 'dist', 'extension.js'),
    join(projectRoot, 'out', 'main', 'index.js'),
    join(projectRoot, 'out', 'main', 'host.js'),
    join(projectRoot, 'out', 'main', 'runtime.js'),
    join(projectRoot, 'out', 'preload', 'index.cjs'),
    join(projectRoot, 'out', 'preload', 'process-explorer.cjs'),
    join(projectRoot, 'out', 'renderer', 'index.html'),
    join(projectRoot, 'out', 'renderer', 'process-explorer.html'),
];
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
 * Guards direct Playwright launches against stale desktop and bundled-extension output. The focused check entrypoint
 * builds first, but direct spec execution can otherwise launch a previously generated `out/main/index.js`.
 */
const buildFreshnessGuard = createBuildFreshnessGuard({
    inputPaths: buildInputPaths,
    outputPaths: buildOutputPaths,
    watchedDirectoryExtensions: watchedBuildInputExtensions,
    staleMessage: staleBuildMessage,
});

export async function assertE2EBuildIsFresh(): Promise<void> {
    await buildFreshnessGuard.assertFresh();
}
