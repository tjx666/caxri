import { dirname } from 'node:path';
import process from 'node:process';

import { defaultUnixSocketDirectory, unixSocketPath } from '@caxri/system';

import { pruneStaleAgentHookSockets } from './server';

/**
 * Resolves this Server process's hook socket path for `profileId` and sweeps sockets left behind by crashed Servers of
 * the same profile.
 *
 * The socket may land outside its preferred directory when that directory is too deep for the `sun_path` limit, so the
 * stale-socket sweep must follow it rather than assume the temp root.
 */
export async function prepareAgentHookSocketPath(profileId: string): Promise<string> {
    const socketPath = unixSocketPath(
        defaultUnixSocketDirectory(),
        `caxri-hooks-${profileId}-${process.pid}.sock`,
    );
    await pruneStaleAgentHookSockets(dirname(socketPath), profileId);
    return socketPath;
}
