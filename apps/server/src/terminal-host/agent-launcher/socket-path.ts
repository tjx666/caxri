import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';

const MAX_PORTABLE_UNIX_SOCKET_PATH_BYTES = 103;

/**
 * Keeps the private launcher socket below macOS's 104-byte `sun_path` limit. The macOS user temp directory is already
 * long enough that embedding a full boot ID prevents Terminal Host from reaching its ready state.
 */
export function managedAgentLauncherSocketPath(directory: string, bootId: string): string {
    if (!isAbsolute(directory))
        throw new Error('Managed Agent launcher directory must be absolute');
    const identity = createHash('sha256').update(bootId, 'utf8').digest('hex').slice(0, 20);
    const path = join(directory, `caxri-a-${identity}.sock`);
    if (Buffer.byteLength(path, 'utf8') > MAX_PORTABLE_UNIX_SOCKET_PATH_BYTES)
        throw new Error('Managed Agent launcher socket path exceeds the portable Unix limit');
    return path;
}
