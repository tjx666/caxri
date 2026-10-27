import { lstat, opendir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { readBoundedRegularFileText } from '@caxri/system';

export const LAYOUT_FILE = '.caxri-layout.json';
const LAYOUT_SCHEMA = 1;
export const MARKER_FILE = '.caxri-skill.json';
const MAX_DIRECTORY_ENTRIES = 32;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_MANAGED_FILES = 16;
export const MAX_TREE_DEPTH = 8;
export const RELEASE_OWNER_FILE = '.caxri-release.json';
export const RELEASES_DIRECTORY = 'releases';

export interface FileIdentity {
    dev: bigint;
    ino: bigint;
}

export interface ManagedRelease {
    files: Record<string, string>;
    identity: FileIdentity;
    markerSource: string;
    path: string;
    relativePath: string;
}

export function isErrno(error: unknown, code: string): boolean {
    return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === code;
}

/**
 * Awaits a best-effort cleanup operation and silently discards its rejection. Used instead of `.catch(() => {})`
 * chaining so cleanup call sites stay `await`-based per `unicorn/prefer-await`.
 */
export async function ignoreRejection(operation: Promise<unknown>): Promise<void> {
    try {
        await operation;
    } catch {
        // Best-effort cleanup; a failure here is reported by the next operation instead.
    }
}

export function identityOf(metadata: { dev: bigint; ino: bigint }): FileIdentity {
    return { dev: metadata.dev, ino: metadata.ino };
}

export function isSameIdentity(left: FileIdentity, right: FileIdentity): boolean {
    return left.dev === right.dev && left.ino === right.ino;
}

export function storeName(skillName: string): string {
    return `.caxri-${skillName}`;
}

export function storePath(target: string, skillName: string): string {
    return join(dirname(target), storeName(skillName));
}

export function releaseTarget(skillName: string, source: string): string | undefined {
    const prefix = `${storeName(skillName)}/${RELEASES_DIRECTORY}/`;
    return source.startsWith(prefix) && /^release-[0-9a-f-]{36}$/u.test(source.slice(prefix.length))
        ? source
        : undefined;
}

function isSafeManagedPath(name: string): boolean {
    const parts = name.split('/');
    return (
        name.length <= 240 &&
        parts.length <= MAX_TREE_DEPTH &&
        parts.every((part) => part.length > 0 && part !== '.' && part !== '..') &&
        !name.startsWith('/') &&
        !name.includes('\0') &&
        name !== MARKER_FILE
    );
}

function markerFiles(source: string): string[] | undefined {
    try {
        const value = JSON.parse(source) as Record<string, unknown>;
        const files = value.files;
        const names = Array.isArray(files)
            ? files.filter((name): name is string => typeof name === 'string')
            : [];
        if (
            !Array.isArray(files) ||
            files.length === 0 ||
            files.length > MAX_MANAGED_FILES ||
            names.length !== files.length ||
            !names.every(isSafeManagedPath) ||
            new Set(names).size !== names.length
        )
            return undefined;
        return names.toSorted((left, right) => left.localeCompare(right));
    } catch {
        return undefined;
    }
}

export function ownedRecord(name: string): string {
    return `${JSON.stringify({ managedBy: 'caxri', name, schemaVersion: LAYOUT_SCHEMA }, null, 2)}\n`;
}

function isOwnedRecord(source: string, name: string): boolean {
    try {
        const value = JSON.parse(source) as Record<string, unknown>;
        return (
            value.schemaVersion === LAYOUT_SCHEMA &&
            value.managedBy === 'caxri' &&
            value.name === name
        );
    } catch {
        return false;
    }
}

async function boundedRegularFile(path: string): Promise<string> {
    // The shared reader opens with `O_NONBLOCK`, so a FIFO planted at the path is rejected instead of parking the open.
    const message = 'Managed skill file is missing or exceeds its size limit';
    return readBoundedRegularFileText(path, MAX_FILE_BYTES, {
        capacityMessage: message,
        notRegularFileMessage: message,
        symlinks: 'nofollow',
    });
}

async function boundedEntries(directory: string): Promise<string[]> {
    const handle = await opendir(directory);
    const entries: string[] = [];
    try {
        for await (const entry of handle) {
            entries.push(entry.name);
            if (entries.length > MAX_DIRECTORY_ENTRIES)
                throw new Error('Managed skill directory exceeds its entry limit');
        }
    } finally {
        try {
            await handle.close();
        } catch {
            // Best-effort close; a directory handle failure here does not affect the entries read.
        }
    }
    return entries.toSorted((left, right) => left.localeCompare(right));
}

export async function assertDirectory(path: string): Promise<FileIdentity> {
    const metadata = await lstat(path, { bigint: true });
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw new Error('Managed skill directory is not a real directory');
    return identityOf(metadata);
}

function directoriesFor(files: readonly string[]): string[] {
    const directories = new Set<string>();
    for (const file of files) {
        let current = dirname(file);
        while (current !== '.') {
            directories.add(current);
            current = dirname(current);
        }
    }
    return [...directories].toSorted(
        (left, right) => left.split('/').length - right.split('/').length,
    );
}

function expectedChildren(files: readonly string[], directory = '.'): string[] {
    const prefix = directory === '.' ? '' : `${directory}/`;
    const children = new Set<string>();
    for (const file of files) {
        if (!file.startsWith(prefix)) continue;
        const remainder = file.slice(prefix.length);
        if (remainder) children.add(remainder.split('/', 1)[0]);
    }
    return [...children].toSorted((left, right) => left.localeCompare(right));
}

export async function validateRelease(
    path: string,
    relativePath: string,
    skillName: string,
): Promise<ManagedRelease> {
    const identity = await assertDirectory(path);
    const markerSource = await boundedRegularFile(join(path, MARKER_FILE));
    const files = markerFiles(markerSource);
    if (!files) throw new Error('Managed skill release marker has an invalid file list');
    const releaseFiles = [...files, MARKER_FILE, RELEASE_OWNER_FILE].toSorted((left, right) =>
        left.localeCompare(right),
    );
    if ((await boundedEntries(path)).join('\0') !== expectedChildren(releaseFiles).join('\0'))
        throw new Error('Managed skill release contains foreign entries');
    await Promise.all(
        directoriesFor(releaseFiles).map(async (directory) => {
            const directoryPath = join(path, ...directory.split('/'));
            await assertDirectory(directoryPath);
            if (
                (await boundedEntries(directoryPath)).join('\0') !==
                expectedChildren(releaseFiles, directory).join('\0')
            )
                throw new Error('Managed skill release contains foreign entries');
        }),
    );
    if (!isOwnedRecord(await boundedRegularFile(join(path, RELEASE_OWNER_FILE)), skillName))
        throw new Error('Managed skill release ownership is invalid');
    const contents = Object.fromEntries(
        await Promise.all(
            files.map(async (file) => [
                file,
                await boundedRegularFile(join(path, ...file.split('/'))),
            ]),
        ),
    ) as Record<string, string>;
    return { files: contents, identity, markerSource, path, relativePath };
}

export async function validateStore(
    path: string,
    skillName: string,
): Promise<{ identity: FileIdentity; releases: Map<string, ManagedRelease> }> {
    const identity = await assertDirectory(path);
    if (
        (await boundedEntries(path)).join('\0') !==
        [LAYOUT_FILE, RELEASES_DIRECTORY]
            .toSorted((left, right) => left.localeCompare(right))
            .join('\0')
    )
        throw new Error('Managed skill store contains foreign entries');
    if (!isOwnedRecord(await boundedRegularFile(join(path, LAYOUT_FILE)), skillName))
        throw new Error('Managed skill store ownership is invalid');
    const releasesPath = join(path, RELEASES_DIRECTORY);
    await assertDirectory(releasesPath);
    const releases = new Map<string, ManagedRelease>();
    const releaseEntries = await Promise.all(
        (await boundedEntries(releasesPath)).map(async (name) => {
            if (/^\.stage-[0-9A-Za-z-]+$/u.test(name)) {
                await assertDirectory(join(releasesPath, name));
                return;
            }
            if (!/^release-[0-9a-f-]{36}$/u.test(name))
                throw new Error('Managed skill store contains an unknown release entry');
            const relativePath = `${storeName(skillName)}/${RELEASES_DIRECTORY}/${name}`;
            return validateRelease(join(releasesPath, name), relativePath, skillName);
        }),
    );
    for (const release of releaseEntries) {
        if (release) releases.set(release.relativePath, release);
    }
    return { identity, releases };
}
