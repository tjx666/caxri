import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
    lstat,
    mkdir,
    mkdtemp,
    open,
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
import { setTimeout as delay } from 'node:timers/promises';

import { CaxriError } from '@caxri/protocol';

const LAYOUT_FILE = '.caxri-layout.json';
const LAYOUT_SCHEMA = 1;
const LOCK_FILE = '.caxri-cli.lock';
const MARKER_FILE = '.caxri-skill.json';
const MAX_DIRECTORY_ENTRIES = 32;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_MANAGED_FILES = 16;
const MAX_REMOVAL_ENTRIES = 1_024;
const MAX_TREE_DEPTH = 8;
const RELEASE_OWNER_FILE = '.caxri-release.json';
const RELEASES_DIRECTORY = 'releases';

interface FileIdentity {
    dev: bigint;
    ino: bigint;
}

export interface ManagedSkillBundle {
    files: Readonly<Record<string, string>>;
    marker: string;
    name: string;
}

interface ManagedRelease {
    files: Record<string, string>;
    identity: FileIdentity;
    markerSource: string;
    path: string;
    relativePath: string;
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

let skillMutationQueue: Promise<void> = Promise.resolve();

function isErrno(error: unknown, code: string): boolean {
    return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === code;
}

function identityOf(metadata: { dev: bigint; ino: bigint }): FileIdentity {
    return { dev: metadata.dev, ino: metadata.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
    return left.dev === right.dev && left.ino === right.ino;
}

function storeName(skillName: string): string {
    return `.caxri-${skillName}`;
}

function storePath(target: string, skillName: string): string {
    return join(dirname(target), storeName(skillName));
}

function releaseTarget(skillName: string, source: string): string | undefined {
    const prefix = `${storeName(skillName)}/${RELEASES_DIRECTORY}/`;
    return source.startsWith(prefix) && /^release-[0-9a-f-]{36}$/u.test(source.slice(prefix.length))
        ? source
        : undefined;
}

function safeManagedPath(name: string): boolean {
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
            !names.every(safeManagedPath) ||
            new Set(names).size !== names.length
        )
            return undefined;
        return names.sort();
    } catch {
        return undefined;
    }
}

function ownedRecord(name: string): string {
    return `${JSON.stringify({ managedBy: 'caxri', name, schemaVersion: LAYOUT_SCHEMA }, null, 2)}\n`;
}

function parseOwnedRecord(source: string, name: string): boolean {
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
    const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
        const metadata = await handle.stat({ bigint: true });
        if (!metadata.isFile() || metadata.size > BigInt(MAX_FILE_BYTES))
            throw new Error('Managed skill file is missing or exceeds its size limit');
        return await handle.readFile({ encoding: 'utf8' });
    } finally {
        await handle.close();
    }
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
        await handle.close().catch(() => undefined);
    }
    return entries.sort();
}

async function assertDirectory(path: string): Promise<FileIdentity> {
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
    return [...directories].sort((left, right) => left.split('/').length - right.split('/').length);
}

function expectedChildren(files: readonly string[], directory = '.'): string[] {
    const prefix = directory === '.' ? '' : `${directory}/`;
    const children = new Set<string>();
    for (const file of files) {
        if (!file.startsWith(prefix)) continue;
        const remainder = file.slice(prefix.length);
        if (remainder) children.add(remainder.split('/')[0]);
    }
    return [...children].sort();
}

async function validateRelease(
    path: string,
    relativePath: string,
    skillName: string,
): Promise<ManagedRelease> {
    const identity = await assertDirectory(path);
    const markerSource = await boundedRegularFile(join(path, MARKER_FILE));
    const files = markerFiles(markerSource);
    if (!files) throw new Error('Managed skill release marker has an invalid file list');
    const releaseFiles = [...files, MARKER_FILE, RELEASE_OWNER_FILE].sort();
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
    if (!parseOwnedRecord(await boundedRegularFile(join(path, RELEASE_OWNER_FILE)), skillName))
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

async function validateStore(
    path: string,
    skillName: string,
): Promise<{ identity: FileIdentity; releases: Map<string, ManagedRelease> }> {
    const identity = await assertDirectory(path);
    if (
        (await boundedEntries(path)).join('\0') !==
        [LAYOUT_FILE, RELEASES_DIRECTORY].sort().join('\0')
    )
        throw new Error('Managed skill store contains foreign entries');
    if (!parseOwnedRecord(await boundedRegularFile(join(path, LAYOUT_FILE)), skillName))
        throw new Error('Managed skill store ownership is invalid');
    const releasesPath = join(path, RELEASES_DIRECTORY);
    await assertDirectory(releasesPath);
    const releases = new Map<string, ManagedRelease>();
    const releaseEntries = await Promise.all(
        (await boundedEntries(releasesPath)).map(async (name) => {
            if (/^\.stage-[0-9A-Za-z-]+$/u.test(name)) {
                await assertDirectory(join(releasesPath, name));
                return undefined;
            }
            if (!/^release-[0-9a-f-]{36}$/u.test(name))
                throw new Error('Managed skill store contains an unknown release entry');
            const relativePath = `${storeName(skillName)}/${RELEASES_DIRECTORY}/${name}`;
            return await validateRelease(join(releasesPath, name), relativePath, skillName);
        }),
    );
    for (const release of releaseEntries) {
        if (release) releases.set(release.relativePath, release);
    }
    return { identity, releases };
}

/** Inspects a Provider-visible skill symlink and its bounded immutable Caxri release. */
export async function inspectManagedSkill(
    target: string,
    bundle: Pick<ManagedSkillBundle, 'files' | 'name'>,
): Promise<ManagedSkillInspection> {
    let metadata;
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
    for (const [name, content] of Object.entries(bundle.files)) {
        const filePath = join(path, ...name.split('/'));
        await mkdir(dirname(filePath), { mode: 0o700, recursive: true });
        await writeFile(filePath, content, { encoding: 'utf8', mode: 0o600 });
    }
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
    let published = false;
    try {
        await writeRelease(stage, bundle);
        await validateRelease(stage, relativePath, bundle.name);
        await rename(stage, releasePath);
        published = true;
        return await validateRelease(releasePath, relativePath, bundle.name);
    } catch (error) {
        await removeOwnedDirectory(published ? releasePath : stage, stageIdentity).catch(
            () => undefined,
        );
        throw error;
    }
}

/** Publishes a complete release with one exclusive symlink creation; foreign targets are never replaced. */
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

/** Atomically switches the Provider-visible directory symlink; a crash sees either complete release. */
export async function updateManagedSkill(
    layout: ManagedSkillLayout,
    bundle: ManagedSkillBundle,
    activate: (source: string, target: string) => Promise<void> = rename,
): Promise<void> {
    const current = await lstat(layout.target, { bigint: true });
    if (
        !current.isSymbolicLink() ||
        !sameIdentity(identityOf(current), layout.identity) ||
        (await readlink(layout.target)) !== layout.activeReleaseTarget
    )
        throw new CaxriError('CONFLICT', 'The skill installation changed during this operation');
    const release = await createRelease(layout.target, bundle);
    const next = `${layout.target}.caxri-next-${randomUUID()}`;
    let activated = false;
    try {
        await symlink(release.relativePath, next);
        await activate(next, layout.target);
        activated = true;
        if ((await readlink(layout.target)) !== release.relativePath)
            throw new CaxriError('CONFLICT', 'The skill activation could not be verified');
    } finally {
        await unlink(next).catch(() => undefined);
        if (!activated) await removeOwnedDirectory(release.path, release.identity);
    }
    await removeOwnedDirectory(layout.activeReleasePath, layout.activeReleaseIdentity).catch(
        () => undefined,
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
        !sameIdentity(inspection.layout.identity, expected.identity) ||
        !sameIdentity(inspection.layout.storeIdentity, expected.storeIdentity) ||
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
    if (!sameIdentity(identity, expected))
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
        await handle.close().catch(() => undefined);
    }
    for (const name of names) {
        const source = join(directory, name);
        const metadata = await lstat(source, { bigint: true });
        const childIdentity = identityOf(metadata);
        const moved = join(directory, `.caxri-delete-${randomUUID()}`);
        await rename(source, moved);
        const movedMetadata = await lstat(moved, { bigint: true });
        if (!sameIdentity(identityOf(movedMetadata), childIdentity))
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
    if (!sameIdentity(moved, expected))
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
        !sameIdentity(identityOf(target), expected.identity) ||
        (await readlink(movedTarget)) !== expected.activeReleaseTarget
    )
        throw new CaxriError('CONFLICT', 'The skill installation changed during cleanup');
    await unlink(movedTarget);
    await removeOwnedDirectory(expected.storePath, expected.storeIdentity);
}

async function assertPreparedParent(location: PreparedSkillParent): Promise<void> {
    const anchored = identityOf(await lstat('.', { bigint: true }));
    const current = identityOf(await lstat(location.parent, { bigint: true }));
    if (!sameIdentity(anchored, location.identity) || !sameIdentity(current, location.identity))
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

function processIsAlive(pid: number): boolean {
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
    if (!sameIdentity(identity, moved) || (await readlink(quarantine)) !== expected)
        throw new CaxriError('CONFLICT', 'The skill operation lock changed unexpectedly');
    await unlink(quarantine);
}

async function acquireLock(location: PreparedSkillParent): Promise<() => Promise<void>> {
    const owner = `caxri-lock-v1-${process.pid}-${Date.now()}-${randomUUID()}`;
    const deadline = Date.now() + 2_000;
    for (;;) {
        await assertPreparedParent(location);
        try {
            await symlink(owner, LOCK_FILE);
            break;
        } catch (error) {
            if (!isErrno(error, 'EEXIST')) throw error;
            let existing: string;
            try {
                existing = await readlink(LOCK_FILE);
            } catch (readError) {
                if (isErrno(readError, 'ENOENT')) continue;
                throw new CaxriError('CONFLICT', 'A foreign skill operation lock is present');
            }
            const parsed = lockOwner(existing);
            if (!parsed)
                throw new CaxriError('CONFLICT', 'A foreign skill operation lock is present');
            if (!processIsAlive(parsed.pid)) {
                try {
                    await moveAndRemoveOwnedLock(LOCK_FILE, existing);
                } catch (moveError) {
                    if (isErrno(moveError, 'ENOENT')) continue;
                    throw moveError;
                }
                continue;
            }
            if (Date.now() >= deadline)
                throw new CaxriError('CONFLICT', 'Another skill operation is still in progress');
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

/** Anchors mutations to the verified directory inode so a later lexical symlink cannot redirect writes. */
export async function withSkillMutationLock<T>(
    location: PreparedSkillParent,
    operation: (anchoredTarget: string) => Promise<T>,
): Promise<T> {
    let releaseQueue = (): void => undefined;
    const previous = skillMutationQueue;
    skillMutationQueue = new Promise<void>((resolveQueue) => {
        releaseQueue = resolveQueue;
    });
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

/** Resolves local installs against the physical Project root and rejects Provider-parent symlinks. */
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
        for (const part of relativeParent.split(sep).filter(Boolean)) {
            current = join(current, part);
            try {
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
        ...(localRoot ? { localRoot } : {}),
        parent,
        target: canonicalTarget,
        targetName: basename(canonicalTarget),
    };
}

/** Checks local Provider parents without creating them or following a project-owned symlink. */
export async function assertSafeLocalTarget(projectRoot: string, target: string): Promise<void> {
    if (!isAbsolute(target)) return;
    const physicalRoot = await realpath(resolve(projectRoot));
    const relativeTarget = relative(physicalRoot, target);
    if (relativeTarget === '..' || relativeTarget.startsWith(`..${sep}`))
        throw new CaxriError('PATH_DENIED', 'The local skill directory escapes the Project root');
    let current = physicalRoot;
    for (const part of dirname(relativeTarget).split(sep).filter(Boolean)) {
        current = join(current, part);
        try {
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
