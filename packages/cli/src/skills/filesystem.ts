import { randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import {
    lstat,
    mkdir,
    mkdtemp,
    opendir,
    readlink,
    realpath,
    rename,
    rmdir,
    symlink,
    unlink,
    writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import { CaxriError } from '@caxri/protocol';

import type { FileIdentity, ManagedRelease } from './filesystem-store.js';
import {
    assertDirectory,
    identityOf,
    ignoreRejection,
    isErrno,
    isSameIdentity,
    LAYOUT_FILE,
    MARKER_FILE,
    ownedRecord,
    RELEASE_OWNER_FILE,
    RELEASES_DIRECTORY,
    releaseTarget,
    storeName,
    storePath,
    validateRelease,
    validateStore,
} from './filesystem-store.js';

const LOCK_FILE = '.caxri-cli.lock';
const MAX_REMOVAL_ENTRIES = 1_024;
const MAX_TREE_DEPTH = 8;

export interface ManagedSkillBundle {
    files: Readonly<Record<string, string>>;
    marker: string;
    name: string;
}

export interface ManagedSkillLayout {
    activeReleaseIdentity: FileIdentity;
    activeReleasePath: string;
    activeReleaseTarget: string;
    files: Record<string, string>;
    identity: FileIdentity;
    markerSource: string;
    storeIdentity: FileIdentity;
    storePath: string;
    target: string;
}

type ManagedSkillInspectionReason =
    'foreign-entry' | 'modified-or-foreign-files' | 'unreadable-installation';

export type ManagedSkillInspection =
    | {
          identity?: FileIdentity;
          kind: 'foreign';
          reason: ManagedSkillInspectionReason;
          target: string;
      }
    | {
          identity: FileIdentity;
          kind: 'invalid';
          reason: ManagedSkillInspectionReason;
          target: string;
      }
    | { kind: 'managed'; layout: ManagedSkillLayout; target: string }
    | { kind: 'missing'; target: string };

export interface PreparedSkillParent {
    identity: FileIdentity;
    localRoot?: string;
    parent: string;
    target: string;
    targetName: string;
}

/**
 * Serializes concurrent `withSkillMutationLock` calls within this process. Kept as a mutable
 * property on a module-level object (rather than a reassigned top-level `let`) so queuing the next
 * waiter is a property write, not a top-level binding reassignment from inside a function.
 */
const skillMutationQueueState: { queue: Promise<void> } = { queue: Promise.resolve() };

/**
Inspects a Provider-visible skill symlink and its bounded immutable Caxri release.
 */
export async function inspectManagedSkill(
    target: string,
    bundle: Pick<ManagedSkillBundle, 'files' | 'name'>,
): Promise<ManagedSkillInspection> {
    let metadata: BigIntStats;
    try {
        metadata = await lstat(target, { bigint: true });
    } catch (error) {
        if (isErrno(error, 'ENOENT')) return { kind: 'missing', target };
        throw error;
    }
    const identity = identityOf(metadata);
    if (!metadata.isSymbolicLink())
        return { identity, kind: 'foreign', reason: 'foreign-entry', target };
    let activeTarget: string;
    try {
        activeTarget = await readlink(target);
    } catch {
        return { identity, kind: 'invalid', reason: 'unreadable-installation', target };
    }
    const safeTarget = releaseTarget(bundle.name, activeTarget);
    if (!safeTarget) return { identity, kind: 'foreign', reason: 'foreign-entry', target };
    try {
        const store = await validateStore(storePath(target, bundle.name), bundle.name);
        const active = store.releases.get(safeTarget);
        if (!active) throw new Error('Active managed skill release is missing');
        return {
            kind: 'managed',
            layout: {
                activeReleaseIdentity: active.identity,
                activeReleasePath: active.path,
                activeReleaseTarget: safeTarget,
                files: active.files,
                identity,
                markerSource: active.markerSource,
                storeIdentity: store.identity,
                storePath: storePath(target, bundle.name),
                target,
            },
            target,
        };
    } catch {
        return { identity, kind: 'invalid', reason: 'modified-or-foreign-files', target };
    }
}

async function writeRelease(path: string, bundle: ManagedSkillBundle): Promise<void> {
    await writeFile(join(path, RELEASE_OWNER_FILE), ownedRecord(bundle.name), {
        encoding: 'utf8',
        mode: 0o600,
    });
    await Promise.all(
        Object.entries(bundle.files).map(async ([name, content]) => {
            const filePath = join(path, ...name.split('/'));
            await mkdir(dirname(filePath), { mode: 0o700, recursive: true });
            await writeFile(filePath, content, { encoding: 'utf8', mode: 0o600 });
        }),
    );
    await writeFile(join(path, MARKER_FILE), bundle.marker, {
        encoding: 'utf8',
        mode: 0o600,
    });
}

async function ensureStore(target: string, bundle: ManagedSkillBundle): Promise<string> {
    const path = storePath(target, bundle.name);
    try {
        await mkdir(path, { mode: 0o700 });
        await writeFile(join(path, LAYOUT_FILE), ownedRecord(bundle.name), {
            encoding: 'utf8',
            mode: 0o600,
        });
        await mkdir(join(path, RELEASES_DIRECTORY), { mode: 0o700 });
    } catch (error) {
        if (!isErrno(error, 'EEXIST')) throw error;
    }
    try {
        await validateStore(path, bundle.name);
    } catch {
        throw new CaxriError(
            'CONFLICT',
            'The Caxri skill release store is foreign, incomplete, or modified',
        );
    }
    return path;
}

async function createRelease(target: string, bundle: ManagedSkillBundle): Promise<ManagedRelease> {
    const store = await ensureStore(target, bundle);
    const releases = join(store, RELEASES_DIRECTORY);
    const stage = await mkdtemp(join(releases, '.stage-'));
    const stageIdentity = await assertDirectory(stage);
    const releaseName = `release-${randomUUID()}`;
    const releasePath = join(releases, releaseName);
    const relativePath = `${storeName(bundle.name)}/${RELEASES_DIRECTORY}/${releaseName}`;
    let isPublished = false;
    try {
        await writeRelease(stage, bundle);
        await validateRelease(stage, relativePath, bundle.name);
        await rename(stage, releasePath);
        isPublished = true;
        return await validateRelease(releasePath, relativePath, bundle.name);
    } catch (error) {
        await ignoreRejection(
            removeOwnedDirectory(isPublished ? releasePath : stage, stageIdentity),
        );
        throw error;
    }
}

/**
Publishes a complete release with one exclusive symlink creation; foreign targets are never replaced.
 */
export async function installManagedSkill(
    target: string,
    bundle: ManagedSkillBundle,
    beforePublish: () => Promise<void> = () => Promise.resolve(),
): Promise<void> {
    const release = await createRelease(target, bundle);
    await beforePublish();
    try {
        await symlink(release.relativePath, target);
    } catch (error) {
        if (isErrno(error, 'EEXIST'))
            throw new CaxriError(
                'CONFLICT',
                'The skill installation changed during this operation',
            );
        throw error;
    }
}

/**
Atomically switches the Provider-visible directory symlink; a crash sees either complete release.
 */
export async function updateManagedSkill(
    layout: ManagedSkillLayout,
    bundle: ManagedSkillBundle,
    activate: (source: string, target: string) => Promise<void> = rename,
): Promise<void> {
    const current = await lstat(layout.target, { bigint: true });
    if (
        !current.isSymbolicLink() ||
        !isSameIdentity(identityOf(current), layout.identity) ||
        (await readlink(layout.target)) !== layout.activeReleaseTarget
    )
        throw new CaxriError('CONFLICT', 'The skill installation changed during this operation');
    const release = await createRelease(layout.target, bundle);
    const next = `${layout.target}.caxri-next-${randomUUID()}`;
    let isActivated = false;
    try {
        await symlink(release.relativePath, next);
        await activate(next, layout.target);
        isActivated = true;
        if ((await readlink(layout.target)) !== release.relativePath)
            throw new CaxriError('CONFLICT', 'The skill activation could not be verified');
    } finally {
        await ignoreRejection(unlink(next));
        if (!isActivated) await removeOwnedDirectory(release.path, release.identity);
    }
    await ignoreRejection(
        removeOwnedDirectory(layout.activeReleasePath, layout.activeReleaseIdentity),
    );
}

export async function assertManagedLayoutUnchanged(
    movedTarget: string,
    expected: ManagedSkillLayout,
    bundle: Pick<ManagedSkillBundle, 'files' | 'name'>,
): Promise<void> {
    const inspection = await inspectManagedSkill(movedTarget, bundle);
    if (
        inspection.kind !== 'managed' ||
        !isSameIdentity(inspection.layout.identity, expected.identity) ||
        !isSameIdentity(inspection.layout.storeIdentity, expected.storeIdentity) ||
        inspection.layout.activeReleaseTarget !== expected.activeReleaseTarget ||
        inspection.layout.markerSource !== expected.markerSource ||
        Object.keys(expected.files).some(
            (name) => inspection.layout.files[name] !== expected.files[name],
        )
    )
        throw new CaxriError('CONFLICT', 'The skill installation changed during this operation');
}

async function clearOwnedDirectory(
    directory: string,
    expected: FileIdentity,
    depth: number,
    progress: { count: number },
): Promise<void> {
    if (depth > MAX_TREE_DEPTH)
        throw new CaxriError('CONFLICT', 'The managed skill cleanup exceeded its depth limit');
    const identity = await assertDirectory(directory);
    if (!isSameIdentity(identity, expected))
        throw new CaxriError('CONFLICT', 'The managed skill changed during cleanup');
    const handle = await opendir(directory);
    const names: string[] = [];
    try {
        for await (const entry of handle) {
            names.push(entry.name);
            progress.count += 1;
            if (progress.count > MAX_REMOVAL_ENTRIES)
                throw new CaxriError(
                    'CONFLICT',
                    'The managed skill cleanup exceeded its entry limit',
                );
        }
    } finally {
        await ignoreRejection(handle.close());
    }
    for (const name of names) {
        // The recursive call below shares the single `progress` counter across the whole tree to
        // enforce `MAX_REMOVAL_ENTRIES`; running entries concurrently would make that count
        // (and therefore the security bound it enforces) nondeterministic.
        // eslint-disable-next-line no-await-in-loop
        await clearOwnedEntry(directory, name, depth, progress);
    }
}

async function clearOwnedEntry(
    directory: string,
    name: string,
    depth: number,
    progress: { count: number },
): Promise<void> {
    const source = join(directory, name);
    const metadata = await lstat(source, { bigint: true });
    const childIdentity = identityOf(metadata);
    const moved = join(directory, `.caxri-delete-${randomUUID()}`);
    await rename(source, moved);
    const movedMetadata = await lstat(moved, { bigint: true });
    if (!isSameIdentity(identityOf(movedMetadata), childIdentity))
        throw new CaxriError('CONFLICT', 'The managed skill changed during cleanup');
    if (movedMetadata.isDirectory() && !movedMetadata.isSymbolicLink()) {
        await clearOwnedDirectory(moved, childIdentity, depth + 1, progress);
        await rmdir(moved);
    } else if (movedMetadata.isFile() || movedMetadata.isSymbolicLink()) await unlink(moved);
    else
        throw new CaxriError(
            'CONFLICT',
            'The managed skill contains an unsupported filesystem entry',
        );
}

async function removeOwnedDirectory(path: string, expected: FileIdentity): Promise<void> {
    const quarantine = `${path}.cleanup-${randomUUID()}`;
    try {
        await rename(path, quarantine);
    } catch (error) {
        if (isErrno(error, 'ENOENT')) return;
        throw error;
    }
    const moved = await assertDirectory(quarantine);
    if (!isSameIdentity(moved, expected))
        throw new CaxriError(
            'CONFLICT',
            'A managed skill directory changed and was preserved during cleanup',
        );
    await clearOwnedDirectory(quarantine, moved, 0, { count: 0 });
    await rmdir(quarantine);
}

export async function removeManagedSkillTree(
    movedTarget: string,
    expected: ManagedSkillLayout,
): Promise<void> {
    const target = await lstat(movedTarget, { bigint: true });
    if (
        !target.isSymbolicLink() ||
        !isSameIdentity(identityOf(target), expected.identity) ||
        (await readlink(movedTarget)) !== expected.activeReleaseTarget
    )
        throw new CaxriError('CONFLICT', 'The skill installation changed during cleanup');
    await unlink(movedTarget);
    await removeOwnedDirectory(expected.storePath, expected.storeIdentity);
}

async function assertPreparedParent(location: PreparedSkillParent): Promise<void> {
    const anchored = identityOf(await lstat('.', { bigint: true }));
    const current = identityOf(await lstat(location.parent, { bigint: true }));
    if (!isSameIdentity(anchored, location.identity) || !isSameIdentity(current, location.identity))
        throw new CaxriError(
            'CONFLICT',
            'The skill installation parent changed during this operation',
        );
    if (location.localRoot && (await realpath(location.parent)) !== location.parent)
        throw new CaxriError(
            'PATH_DENIED',
            'The local skill directory contains an unsafe symbolic link or entry',
        );
}

function lockOwner(source: string): { pid: number } | undefined {
    const match = /^caxri-lock-v1-(\d+)-\d+-[0-9a-f-]{36}$/u.exec(source);
    if (!match) return undefined;
    const pid = Number(match[1]);
    return Number.isSafeInteger(pid) && pid > 0 ? { pid } : undefined;
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return !isErrno(error, 'ESRCH');
    }
}

async function moveAndRemoveOwnedLock(lock: string, expected: string): Promise<void> {
    const quarantine = `${lock}.released-${randomUUID()}`;
    const identity = identityOf(await lstat(lock, { bigint: true }));
    await rename(lock, quarantine);
    const moved = identityOf(await lstat(quarantine, { bigint: true }));
    if (!isSameIdentity(identity, moved) || (await readlink(quarantine)) !== expected)
        throw new CaxriError('CONFLICT', 'The skill operation lock changed unexpectedly');
    await unlink(quarantine);
}

async function acquireLock(location: PreparedSkillParent): Promise<() => Promise<void>> {
    const owner = `caxri-lock-v1-${process.pid}-${Date.now()}-${randomUUID()}`;
    const deadline = Date.now() + 2_000;
    // This is a polling retry loop for an exclusive filesystem lock; each iteration must observe
    // the outcome of the previous attempt before retrying, so the awaits below cannot be
    // parallelized across iterations.
    for (;;) {
        // eslint-disable-next-line no-await-in-loop
        await assertPreparedParent(location);
        try {
            // eslint-disable-next-line no-await-in-loop
            await symlink(owner, LOCK_FILE);
            break;
        } catch (error) {
            if (!isErrno(error, 'EEXIST')) throw error;
            let existing: string;
            try {
                // eslint-disable-next-line no-await-in-loop
                existing = await readlink(LOCK_FILE);
            } catch (readError) {
                if (isErrno(readError, 'ENOENT')) continue;
                throw new CaxriError('CONFLICT', 'A foreign skill operation lock is present');
            }
            const parsed = lockOwner(existing);
            if (!parsed)
                throw new CaxriError('CONFLICT', 'A foreign skill operation lock is present');
            if (!isProcessAlive(parsed.pid)) {
                try {
                    // eslint-disable-next-line no-await-in-loop
                    await moveAndRemoveOwnedLock(LOCK_FILE, existing);
                } catch (moveError) {
                    if (isErrno(moveError, 'ENOENT')) continue;
                    throw moveError;
                }
                continue;
            }
            if (Date.now() >= deadline)
                throw new CaxriError('CONFLICT', 'Another skill operation is still in progress');
            // eslint-disable-next-line no-await-in-loop
            await delay(20);
        }
    }
    return async () => {
        try {
            await moveAndRemoveOwnedLock(LOCK_FILE, owner);
        } catch {
            // A replaced lock is preserved and reported by the next operation rather than deleted.
        }
    };
}

/**
Anchors mutations to the verified directory inode so a later lexical symlink cannot redirect writes.
 */
export async function withSkillMutationLock<T>(
    location: PreparedSkillParent,
    operation: (anchoredTarget: string) => Promise<T>,
): Promise<T> {
    const { promise: queued, resolve: releaseQueue } = Promise.withResolvers<void>();
    const previous = skillMutationQueueState.queue;
    skillMutationQueueState.queue = queued;
    await previous;
    const originalDirectory = process.cwd();
    try {
        process.chdir(location.parent);
        await assertPreparedParent(location);
        const release = await acquireLock(location);
        try {
            const result = await operation(location.targetName);
            await assertPreparedParent(location);
            return result;
        } finally {
            await release();
        }
    } finally {
        process.chdir(originalDirectory);
        releaseQueue();
    }
}

async function ensureRealDirectory(path: string): Promise<void> {
    try {
        await mkdir(path, { mode: 0o700 });
    } catch (error) {
        if (!isErrno(error, 'EEXIST')) throw error;
    }
    await assertDirectory(path);
}

/**
Resolves local installs against the physical Project root and rejects Provider-parent symlinks.
 */
export async function prepareSkillParent(
    target: string,
    localProjectRoot?: string,
): Promise<PreparedSkillParent> {
    let parent = dirname(target);
    let localRoot: string | undefined;
    if (localProjectRoot) {
        const physicalRoot = await realpath(resolve(localProjectRoot));
        localRoot = physicalRoot;
        const relativeParent = relative(physicalRoot, parent);
        if (
            relativeParent === '..' ||
            relativeParent.startsWith(`..${sep}`) ||
            resolve(physicalRoot, relativeParent) !== parent
        )
            throw new CaxriError(
                'PATH_DENIED',
                'The local skill directory escapes the Project root',
            );
        let current = physicalRoot;
        const parts = relativeParent.split(sep).filter(Boolean);
        for (const part of parts) {
            current = join(current, part);
            try {
                // Each iteration walks one path segment deeper from the previous iteration's
                // resolved `current`, so these directory checks must happen in path order.
                // eslint-disable-next-line no-await-in-loop
                await ensureRealDirectory(current);
            } catch {
                throw new CaxriError(
                    'PATH_DENIED',
                    'The local skill directory contains an unsafe symbolic link or entry',
                );
            }
        }
    } else {
        await mkdir(parent, { mode: 0o700, recursive: true });
        await assertDirectory(parent);
        parent = await realpath(parent);
    }
    const canonicalTarget = join(parent, basename(target));
    return {
        identity: await assertDirectory(parent),
        ...(localRoot && { localRoot }),
        parent,
        target: canonicalTarget,
        targetName: basename(canonicalTarget),
    };
}

/**
Checks local Provider parents without creating them or following a project-owned symlink.
 */
export async function assertSafeLocalTarget(projectRoot: string, target: string): Promise<void> {
    if (!isAbsolute(target)) return;
    const physicalRoot = await realpath(resolve(projectRoot));
    const relativeTarget = relative(physicalRoot, target);
    if (relativeTarget === '..' || relativeTarget.startsWith(`..${sep}`))
        throw new CaxriError('PATH_DENIED', 'The local skill directory escapes the Project root');
    let current = physicalRoot;
    const parts = dirname(relativeTarget).split(sep).filter(Boolean);
    for (const part of parts) {
        current = join(current, part);
        try {
            // Each iteration walks one path segment deeper from the previous iteration's resolved
            // `current`, so these directory checks must happen in path order.
            // eslint-disable-next-line no-await-in-loop
            await assertDirectory(current);
        } catch (error) {
            if (isErrno(error, 'ENOENT')) return;
            throw new CaxriError(
                'PATH_DENIED',
                'The local skill directory contains an unsafe symbolic link or entry',
            );
        }
    }
}
