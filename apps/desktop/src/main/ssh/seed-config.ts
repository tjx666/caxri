import { join } from 'node:path';

import { MAX_CONFIGURATION_SOURCE_BYTES } from '@caxri/protocol';
import { readBoundedRegularFileText } from '@caxri/system';

import type { RemoteSeedConfig } from './remote-server-supervisor-options';

/**
 * One local config source, or `undefined` to skip it. A missing file, a non-regular file such as a FIFO, one past the
 * shared configuration source cap, and any read fault all skip that source only: the SSH Host then creates its own
 * default, which is the same outcome as a missing file. The bounded read opens non-blocking and caps one handle, so a
 * FIFO planted at the path cannot stall the first connect and a huge or growing file is never fully materialized.
 */
async function readSeedSource(path: string): Promise<string | undefined> {
    try {
        return await readBoundedRegularFileText(path, MAX_CONFIGURATION_SOURCE_BYTES);
    } catch {
        return undefined;
    }
}

/**
 * Reads the local profile's settings, keybindings, and theme so a first connect to an SSH Host starts from the same
 * Workbench. A missing or unusable file is skipped; the SSH Host never overwrites a file it already has.
 */
export async function readSeedConfig(configDirectory: string): Promise<RemoteSeedConfig> {
    const [settings, keybindings, theme] = await Promise.all([
        readSeedSource(join(configDirectory, 'settings.jsonc')),
        readSeedSource(join(configDirectory, 'keybindings.jsonc')),
        readSeedSource(join(configDirectory, 'theme.json')),
    ]);
    return { keybindings, settings, theme };
}
