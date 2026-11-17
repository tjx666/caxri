import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { redactLogValue } from '@caxri/system';

import { readSuffix } from './introspection';

/**
 * Newest bytes read from each retained log file when a diagnostics read only needs recent history (`snapshot` and the
 * bug-report context). The logger keeps up to 20 MiB x 3 generations per process, so reading every file whole costs
 * hundreds of MiB each time the report dialog opens. 2 MiB per file still covers the recent error IDs, the performance
 * window, and the Bot completion notices of a busy `debug` profile; the total held is at most 2 MiB per retained file
 * (about 24 MiB worst case), never the whole retention.
 */
export const DIAGNOSTIC_LOG_TAIL_BYTES = 2 * 1024 * 1024;

/**
 * Bounded tails of the named log files in `directory`, partial first line dropped. An unreadable file reads as empty so
 * a snapshot never fails on one bad log.
 */
export async function readDiagnosticLogTails(
    directory: string,
    names: readonly string[],
    maximumBytes = DIAGNOSTIC_LOG_TAIL_BYTES,
): Promise<string[]> {
    return Promise.all(
        names.map(async (name) => {
            try {
                return await readSuffix(join(directory, name), maximumBytes);
            } catch {
                return '';
            }
        }),
    );
}

/**
 * Yields a whole log file with {@link redactLogValue} applied to one batch of complete lines at a time, so an export
 * never holds a file (or its redacted copy) in memory. Log records are single-line JSON, so redacting per line batch
 * yields the same text as redacting the whole file; the trailing partial line, if any, is redacted at the end.
 *
 * @yields {string} Redacted text ending at a line boundary (the last chunk may lack the final newline, as the file
 *   does).
 */
async function* redactedLogChunks(path: string): AsyncGenerator<string> {
    const source = createReadStream(path, { encoding: 'utf8' });
    let pending = '';
    for await (const chunk of source) {
        pending += chunk as string;
        const lastNewline = pending.lastIndexOf('\n');
        if (lastNewline === -1) continue;
        yield redactLogValue(pending.slice(0, lastNewline + 1));
        pending = pending.slice(lastNewline + 1);
    }
    if (pending) yield redactLogValue(pending);
}

/**
 * The redacted log as a byte stream for one archive entry.
 */
export function redactedLogStream(path: string): Readable {
    return Readable.from(redactedLogChunks(path), { objectMode: false });
}

/**
 * Feeds every redacted chunk of each file to `onChunk`, one file at a time.
 */
export async function forEachRedactedLogChunk(
    paths: readonly string[],
    onChunk: (chunk: string) => void,
): Promise<void> {
    for (const path of paths) {
        const chunks = redactedLogChunks(path);
        // Sequential by design: one open file and one batch in memory at a time is the bound this helper exists for.
        // eslint-disable-next-line no-await-in-loop
        for await (const chunk of chunks) onChunk(chunk);
    }
}
