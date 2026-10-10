import type { Stats } from 'node:fs';

import { isCaxriError, MAX_CONFIGURATION_SOURCE_BYTES } from '@caxri/protocol';

import { readBoundedRegularFileText } from '../bounded-file-reader';

/**
 * Raised by {@link readBoundedConfigSource} when a configuration file cannot be read as a bounded, regular file. Carries
 * `revision` so a caller can tell one rejected read apart from another for the same path.
 */
export class ConfigSourceReadError extends Error {
    constructor(
        message: string,
        readonly revision: string,
    ) {
        super(message);
        this.name = 'ConfigurationSourceReadError';
    }
}

function sourceRevision(metadata: Stats): string {
    return [metadata.dev, metadata.ino, metadata.size, metadata.mtimeMs, metadata.ctimeMs].join(
        ':',
    );
}

/**
 * Reads a configuration source file with a hard byte ceiling, refusing anything larger without loading the whole file
 * into memory first.
 *
 * The shared bounded reader owns the open, so a FIFO planted at a configuration path is refused instead of blocking the
 * load until a writer appears. Its own rejections arrive as `CaxriError`s after the handle's metadata was inspected;
 * each is rewrapped with that handle's revision so polling can suppress a repeat of the same rejected file, while a
 * filesystem fault such as `ENOENT` propagates unchanged for the create-on-missing path.
 */
export async function readBoundedConfigSource(path: string): Promise<string> {
    let revision: string | undefined;
    try {
        return await readBoundedRegularFileText(path, MAX_CONFIGURATION_SOURCE_BYTES, {
            capacityMessage: `Configuration source exceeds the ${MAX_CONFIGURATION_SOURCE_BYTES} byte configuration source limit`,
            inspect: (metadata) => {
                revision = sourceRevision(metadata);
            },
            notRegularFileMessage: 'Configuration source is not a regular file',
        });
    } catch (error) {
        if (revision !== undefined && isCaxriError(error))
            throw new ConfigSourceReadError(error.message, revision);
        throw error;
    }
}
