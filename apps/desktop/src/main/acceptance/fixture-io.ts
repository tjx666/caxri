import { constants } from 'node:fs';
import { appendFile } from 'node:fs/promises';

import { readBoundedRegularFileText } from '@caxri/system';
import type { z } from 'zod';

const MAX_COMMAND_BYTES = 4096;

/**
 * Reads and validates one Acceptance fixture command file. The file must be a regular file of at most 4 KiB reached
 * without following a final symlink; anything else rejects before the schema sees it.
 */
export async function readAcceptanceCommand<Schema extends z.ZodType>(
    path: string,
    schema: Schema,
): Promise<z.infer<Schema>> {
    const text = await readBoundedRegularFileText(path, MAX_COMMAND_BYTES, {
        symlinks: 'nofollow',
    });
    return schema.parse(JSON.parse(text));
}

/**
 * Appends one JSON line to an Acceptance fixture receipt, creating it with mode 0600 and refusing a final symlink.
 */
export async function appendAcceptanceReceipt(
    path: string,
    record: Record<string, unknown>,
): Promise<void> {
    await appendFile(path, `${JSON.stringify(record)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW,
    });
}
