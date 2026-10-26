import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import type { ServerDesktopCredential, ServerManifest } from '@caxri/protocol';
import { CaxriError, serverDesktopCredentialSchema, serverManifestSchema } from '@caxri/protocol';

/**
 * Also bounds the control-frame size `ServerClient` accepts; see `client.ts`.
 */
export const MAX_MANIFEST_BYTES = 16 * 1024;

/**
 * Messages the CLI matches (see `withNextStep` in apps/cli) to attach a next step. Shared so the wording of the two
 * layers cannot drift apart silently.
 */
export const PROFILE_MISSING_MESSAGE = 'The selected Caxri profile does not exist';
export const SERVER_NOT_RUNNING_MESSAGE = 'No Caxri Server is running for this profile';

function fileSystemCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String(Reflect.get(error, 'code'))
        : undefined;
}

function profileIdFor(path: string): string {
    return createHash('sha256').update(path).digest('hex').slice(0, 24);
}

/**
 * Server shutdown may unlink discovery data after `lstat`; keep that race classified as absence.
 */
async function readDiscoveryJson(
    path: string,
    notFoundMessage: string,
    malformedMessage: string,
): Promise<unknown> {
    let contents: string;
    try {
        contents = await readFile(path, 'utf8');
    } catch (error) {
        if (fileSystemCode(error) === 'ENOENT') throw new CaxriError('NOT_FOUND', notFoundMessage);
        throw new CaxriError('VALIDATION', malformedMessage);
    }
    try {
        return JSON.parse(contents) as unknown;
    } catch {
        throw new CaxriError('VALIDATION', malformedMessage);
    }
}

/**
 * Reads only the private discovery record; business state always goes through Server commands.
 */
export async function discoverServerManifest(userDataPath: string): Promise<ServerManifest> {
    let canonicalPath: string;
    try {
        canonicalPath = await realpath(userDataPath);
    } catch (error) {
        if (fileSystemCode(error) === 'ENOENT')
            throw new CaxriError('NOT_FOUND', PROFILE_MISSING_MESSAGE);
        throw error;
    }
    const directory = join(canonicalPath, 'host');
    const path = join(directory, 'manifest.json');
    let metadata: Stats;
    try {
        const directoryMetadata = await lstat(directory);
        if (
            !directoryMetadata.isDirectory() ||
            directoryMetadata.isSymbolicLink() ||
            (directoryMetadata.mode & 0o077) !== 0 ||
            (typeof process.getuid === 'function' && directoryMetadata.uid !== process.getuid())
        )
            throw new CaxriError('PATH_DENIED', 'Caxri Server discovery directory is not private');
        metadata = await lstat(path);
    } catch (error) {
        if (fileSystemCode(error) === 'ENOENT')
            throw new CaxriError('NOT_FOUND', SERVER_NOT_RUNNING_MESSAGE);
        throw error;
    }
    if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        (metadata.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
    )
        throw new CaxriError('PATH_DENIED', 'Caxri Server discovery metadata is not private');
    if (metadata.size > MAX_MANIFEST_BYTES)
        throw new CaxriError('VALIDATION', 'Caxri Server discovery metadata is oversized');
    const source = await readDiscoveryJson(
        path,
        SERVER_NOT_RUNNING_MESSAGE,
        'Caxri Server discovery metadata is malformed',
    );
    const parsed = serverManifestSchema.safeParse(source);
    if (!parsed.success)
        throw new CaxriError('VALIDATION', 'Caxri Server discovery metadata is invalid');
    if (parsed.data.profileId !== profileIdFor(canonicalPath))
        throw new CaxriError('CONFLICT', 'Caxri Server discovery profile identity does not match');
    return parsed.data;
}

/**
 * Reads the Desktop-only credential and binds it to the current Server process identity.
 */
export async function discoverDesktopCredential(
    userDataPath: string,
    manifest: ServerManifest,
): Promise<ServerDesktopCredential> {
    const canonicalPath = await realpath(userDataPath);
    const path = join(canonicalPath, 'host', 'desktop-credential.json');
    let metadata: Stats;
    try {
        metadata = await lstat(path);
    } catch (error) {
        if (fileSystemCode(error) === 'ENOENT')
            throw new CaxriError('NOT_FOUND', 'Caxri Desktop credential is unavailable');
        throw error;
    }
    if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        (metadata.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) ||
        metadata.size > MAX_MANIFEST_BYTES
    )
        throw new CaxriError('PATH_DENIED', 'Caxri Desktop credential is not private');
    const source = await readDiscoveryJson(
        path,
        'Caxri Desktop credential is unavailable',
        'Caxri Desktop credential is malformed',
    );
    const parsed = serverDesktopCredentialSchema.safeParse(source);
    if (!parsed.success) throw new CaxriError('VALIDATION', 'Caxri Desktop credential is invalid');
    if (
        parsed.data.profileId !== manifest.profileId ||
        parsed.data.processIdentity !== manifest.processIdentity
    )
        throw new CaxriError('CONFLICT', 'Caxri Desktop credential belongs to another Server');
    return parsed.data;
}
