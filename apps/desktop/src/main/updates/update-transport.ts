import { Buffer } from 'node:buffer';
import type { FileHandle } from 'node:fs/promises';

import type { UpdateState } from '@caxri/protocol';
import { errorMessage } from '@caxri/protocol';

import { readCappedBody } from '@caxri/system';

export const MAX_RELEASE_RESPONSE_BYTES = 1024 * 1024;
export const MAX_CHECKSUM_BYTES = 4 * 1024;
export const MAX_DMG_BYTES = 1024 * 1024 * 1024;
export const PROGRESS_INTERVAL_MS = 100;

export type UpdateFailureKind = Extract<UpdateState, { status: 'error' }>['failureKind'];

/**
 * Carries an actionable category without making the Renderer parse platform diagnostics.
 */
export class UpdateFailure extends Error {
    constructor(
        readonly kind: UpdateFailureKind,
        message: string,
    ) {
        super(message);
    }
}

export function updateFailureKind(error: unknown): UpdateFailureKind {
    return error instanceof UpdateFailure ? error.kind : 'other';
}

export async function readUpdateNetwork<T>(operation: () => Promise<T>): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        if (isAbortError(error)) throw error;
        throw new UpdateFailure('network', errorMessage(error, 'The update connection failed.'));
    }
}

export function assertSuccessfulResponse(response: Response, label: string): void {
    if (!response.ok)
        throw new UpdateFailure('network', `${label} failed with status ${response.status}.`);
}

export async function readBoundedResponse(
    response: Response,
    maximumBytes: number,
): Promise<Uint8Array> {
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes)
        throw new Error('The update response is larger than expected.');
    if (!response.body) throw new Error('The update response was empty.');

    const chunks: Uint8Array[] = [];
    const end = await readUpdateNetwork(() =>
        readCappedBody(response, maximumBytes, (chunk) => {
            chunks.push(chunk);
        }),
    );
    if (end === 'limit') throw new Error('The update response is larger than expected.');
    return Buffer.concat(chunks);
}

export function parseChecksum(source: string, fileName: string): string {
    // Parsed without a single combined `\s+\*?` pattern, which is vulnerable to super-linear
    // backtracking; the hex digest, optional binary-mode marker, and file name are each matched
    // independently instead.
    const trimmed = source.trim();
    const separatorIndex = trimmed.search(/\s/);
    if (separatorIndex === -1)
        throw new UpdateFailure('integrity', 'The release checksum file is invalid.');
    const hex = trimmed.slice(0, separatorIndex);
    const name = trimmed.slice(separatorIndex).trimStart().replace(/^\*/, '');
    if (name !== fileName || !/^[0-9a-f]{64}$/i.test(hex))
        throw new UpdateFailure('integrity', 'The release checksum file is invalid.');
    return hex.toLowerCase();
}

export function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
}

export function updateErrorMessage(error: unknown, fallback: string): string {
    return errorMessage(error, fallback).slice(0, 2_048) || fallback;
}

export async function writeAll(file: FileHandle, bytes: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < bytes.byteLength) {
        // Each write must observe the previous write's byte count before advancing the offset,
        // so this cannot be parallelized.
        // eslint-disable-next-line no-await-in-loop -- sequential file write, see comment above
        const { bytesWritten } = await file.write(bytes, offset);
        if (bytesWritten === 0) throw new Error('The update file could not be written.');
        offset += bytesWritten;
    }
}
