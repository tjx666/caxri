import { resolve } from 'node:path';

import { computeBuildSourceKey, verifyBuildReceipt } from '../../scripts/build-receipt.ts';

const projectRoot = resolve(import.meta.dirname, '../..');
/**
 * Memoized per worker process; specs must not rewrite build inputs while it runs.
 */
const workerSourceKey: { current?: Promise<string> } = {};

/**
 * Guards direct Playwright launches against stale desktop and bundled-extension output with the same receipt that lets
 * `check --e2e` skip a rebuild. Any build flavor is accepted, since a benchmark deliberately runs a profiling build.
 * The source key is computed once per worker because specs must not rewrite build inputs; the output trees are
 * rechecked on every launch so a deleted or rebuilt bundle is still caught.
 */
export async function assertE2EBuildIsFresh(executablePath?: string): Promise<void> {
    // A packaged executable carries its own build (often another Source Map flavor); only `out/` launches need this.
    if (executablePath) return;
    workerSourceKey.current ??= computeBuildSourceKey(projectRoot);
    const status = await verifyBuildReceipt(projectRoot, {
        purpose: 'launch',
        sourceKey: await workerSourceKey.current,
    });
    if (!status.isValid)
        throw new Error(
            `Build output is stale (${status.reason}): run "bun run build" before running e2e specs.`,
        );
}
