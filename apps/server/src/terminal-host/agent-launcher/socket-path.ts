import { createHash } from 'node:crypto';

import { unixSocketPath } from '@caxri/system';

/**
 * Names the private launcher socket after the Terminal Host boot it belongs to, then lets {@link unixSocketPath} decide
 * whether the caller's directory can hold it. The hash keeps the name a fixed 33 bytes regardless of how long the boot
 * identifier is, so the directory budget never depends on the caller's identifiers.
 */
export function managedAgentLauncherSocketPath(directory: string, bootId: string): string {
    const identity = createHash('sha256').update(bootId, 'utf8').digest('hex').slice(0, 20);
    return unixSocketPath(directory, `caxri-a-${identity}.sock`);
}
