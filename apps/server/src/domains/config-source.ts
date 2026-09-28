import { Buffer } from 'node:buffer';
import { open } from 'node:fs/promises';

import { MAX_CONFIGURATION_SOURCE_BYTES } from '@caxri/protocol';

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

/**
 * Reads a configuration source file with a hard byte ceiling, refusing anything larger without loading the whole file
 * into memory first.
 */
export async function readBoundedConfigSource(path: string): Promise<string> {
    const file = await open(path, 'r');
    try {
        const metadata = await file.stat();
        const revision = [
            metadata.dev,
            metadata.ino,
            metadata.size,
            metadata.mtimeMs,
            metadata.ctimeMs,
        ].join(':');
        if (!metadata.isFile()) {
            throw new ConfigSourceReadError('Configuration source is not a regular file', revision);
        }
        if (metadata.size > MAX_CONFIGURATION_SOURCE_BYTES) {
            throw new ConfigSourceReadError(
                `Configuration source exceeds the ${MAX_CONFIGURATION_SOURCE_BYTES} byte configuration source limit`,
                revision,
            );
        }

        /**
         * The extra byte detects growth between stat and read without loading the full file.
         */
        const buffer = Buffer.allocUnsafe(MAX_CONFIGURATION_SOURCE_BYTES + 1);
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
            // Each read's offset depends on the byte count already read, so the reads are
            // inherently sequential and cannot be batched with Promise.all.
            // eslint-disable-next-line no-await-in-loop -- sequential-by-offset read, see comment above
            const result = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
            if (result.bytesRead === 0) break;
            bytesRead += result.bytesRead;
        }
        if (bytesRead > MAX_CONFIGURATION_SOURCE_BYTES) {
            throw new ConfigSourceReadError(
                `Configuration source exceeds the ${MAX_CONFIGURATION_SOURCE_BYTES} byte configuration source limit`,
                revision,
            );
        }
        return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
        await file.close();
    }
}
