import { connectToServer, discoverServerManifest } from '@caxri/client/supervise';

import { getProcessIdentity } from '../../.agents/skills/switch-worktree/scripts/process';

function errorCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String(Reflect.get(error, 'code'))
        : undefined;
}

async function manifestIfPresent(userDataDirectory: string) {
    try {
        return await discoverServerManifest(userDataDirectory);
    } catch (error) {
        if (errorCode(error) === 'NOT_FOUND') return;
        throw error;
    }
}

/**
 * Host.stop acknowledges the request before shutdown finishes. Keep the profile and lease alive until both discovery
 * and the original OS process disappear; a replacement Host must never be mistaken for the one this launch owns.
 */
export async function stopE2EHost(userDataDirectory: string): Promise<void> {
    const manifest = await manifestIfPresent(userDataDirectory);
    if (!manifest) return;
    const identity = await getProcessIdentity(manifest.pid);
    let client: Awaited<ReturnType<typeof connectToServer>> | undefined;
    try {
        client = await connectToServer(userDataDirectory, 2_000);
        await client.request('host.stop', { confirmLivePtys: true });
    } catch (error) {
        if (errorCode(error) !== 'NOT_FOUND' && errorCode(error) !== 'UNAVAILABLE') throw error;
    } finally {
        client?.close();
    }
    /**
     * Terminal shutdown owns 30 seconds and Extension shutdown another five.
     */
    const deadline = Date.now() + 40_000;
    while (true) {
        // eslint-disable-next-line no-await-in-loop -- shutdown observations must be sequential.
        const current = await manifestIfPresent(userDataDirectory);
        if (current && current.processIdentity !== manifest.processIdentity)
            throw new Error('E2E Host was replaced during shutdown');

        // eslint-disable-next-line no-await-in-loop -- compare the original OS lifetime on each poll.
        const currentIdentity = await getProcessIdentity(manifest.pid);
        const isAlive = identity !== undefined && currentIdentity === identity;
        if (!current && !isAlive) return;
        if (Date.now() >= deadline) throw new Error('Timed out waiting for the E2E Host to stop');
        // eslint-disable-next-line no-await-in-loop -- bounded shutdown polling interval.
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

/**
 * Failed shutdown keeps the desktop lease owned until the worker's explicit recovery runs.
 */
export async function releaseE2EHost(
    userDataDirectory: string,
    shouldPreserveHost: boolean,
    release: () => Promise<void>,
): Promise<void> {
    if (!shouldPreserveHost) await stopE2EHost(userDataDirectory);
    await release();
}
