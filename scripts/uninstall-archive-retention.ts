import type { Stats } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { writeJsonAtomic } from './atomic-json';

const UNINSTALL_ARCHIVE_NAME =
    /^uninstall-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-[a-z0-9]+$/iu;

interface ArchiveManifest {
    archiveDirectory: string;
    targets: Array<{ status: string }>;
}

type ArchiveStatus = 'archived' | 'failed' | 'missing' | 'planned';

export interface UninstallArchiveManifest {
    archiveDirectory: string;
    createdAt: string;
    schemaVersion: 1;
    targets: Array<{
        archivedPath: string;
        error?: string;
        originalPath: string;
        status: ArchiveStatus;
    }>;
}

export interface ArchivePruneFailure {
    message: string;
    path: string;
}

function fileSystemCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String(Reflect.get(error, 'code'))
        : undefined;
}

function isOwnedDirectory(metadata: Stats): boolean {
    return (
        metadata.isDirectory() &&
        !metadata.isSymbolicLink() &&
        (typeof process.getuid !== 'function' || metadata.uid === process.getuid())
    );
}

export async function createArchiveDirectory(archiveRootPath: string): Promise<string> {
    const root = resolve(archiveRootPath);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const metadata = await lstat(root);
    if (!isOwnedDirectory(metadata))
        throw new Error(`Refusing unsafe Caxri uninstall archive root: ${root}`);
    const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, '-');
    return mkdtemp(join(root, `uninstall-${timestamp}-`));
}

export async function writeArchiveManifest(manifest: UninstallArchiveManifest): Promise<void> {
    await writeJsonAtomic(join(manifest.archiveDirectory, 'manifest.json'), manifest, {
        mode: 0o600,
    });
}

export async function completedArchiveCandidates(
    archiveRootPath: string,
    beforeName?: string,
): Promise<string[]> {
    const root = resolve(archiveRootPath);
    const beforeTimestamp = beforeName?.match(UNINSTALL_ARCHIVE_NAME)?.[1];
    if (beforeName !== undefined && beforeTimestamp === undefined) return [];
    let rootMetadata: Stats;
    try {
        rootMetadata = await lstat(root);
    } catch (error) {
        if (fileSystemCode(error) === 'ENOENT') return [];
        throw error;
    }
    if (!isOwnedDirectory(rootMetadata))
        throw new Error(`Refusing unsafe Caxri uninstall archive root: ${root}`);

    const candidates: string[] = [];
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
        const timestamp = entry.name.match(UNINSTALL_ARCHIVE_NAME)?.[1];
        if (
            timestamp === undefined ||
            !entry.isDirectory() ||
            (beforeTimestamp !== undefined && timestamp >= beforeTimestamp)
        )
            continue;
        const archive = join(root, entry.name);
        // eslint-disable-next-line no-await-in-loop -- every candidate is validated before destructive use
        const metadata = await lstat(archive);
        if (!isOwnedDirectory(metadata)) continue;
        try {
            // eslint-disable-next-line no-await-in-loop -- manifests are bounded and validated independently
            const source = await readFile(join(archive, 'manifest.json'), 'utf8');
            const manifest = JSON.parse(source) as Partial<ArchiveManifest>;
            if (
                manifest.archiveDirectory !== archive ||
                !Array.isArray(manifest.targets) ||
                manifest.targets.every((target) => target.status !== 'archived') ||
                manifest.targets.some((target) => !['archived', 'missing'].includes(target.status))
            )
                continue;
            candidates.push(archive);
        } catch {
            // Unknown recovery data is retained rather than treated as a completed archive.
        }
    }
    return candidates.toSorted((left, right) => left.localeCompare(right));
}

export async function pruneCompletedArchives(candidates: readonly string[]): Promise<{
    failures: ArchivePruneFailure[];
    pruned: string[];
}> {
    const results = await Promise.allSettled(
        candidates.map((archive) => rm(archive, { recursive: true })),
    );
    const failures: ArchivePruneFailure[] = [];
    const pruned: string[] = [];
    results.forEach((result, index) => {
        const path = candidates[index];
        if (result.status === 'fulfilled') pruned.push(path);
        else failures.push({ message: String(result.reason), path });
    });
    return { failures, pruned };
}
