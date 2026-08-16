import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { wasFinalizationArtifactRecovered } from './finalization';
import { verifyHandoffReportArtifact } from './handoff-report';
import { applyLedgerRetention, verifyLedgerRetention } from './ledger-retention';
import type { GoState } from './state-model';
import { now, validateState } from './state-model';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
export const PROJECT_ROOT = resolve(dirname(SCRIPT_PATH), '../../../..');
const RECORDS_ROOT = join(PROJECT_ROOT, '.records');
const STATE_ROOT = join(RECORDS_ROOT, 'go');
const RUN_DIRECTORIES = [
    'reviews',
    'validation',
    'ci-artifacts',
    'acceptance',
    'artifacts',
] as const;

interface DirectDirectorySnapshot {
    canonicalPath: string;
    dev: number;
    ino: number;
}

interface DirectFileSnapshot {
    dev: number;
    ino: number;
    parent: DirectDirectorySnapshot;
}

function errorCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
    return typeof error.code === 'string' ? error.code : undefined;
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

function assertOwned(metadata: Stats, label: string): void {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (uid !== null && metadata.uid !== uid)
        throw new Error(`${label} must be owned by this user`);
}

function hasSameIdentity(left: { dev: number; ino: number }, right: { dev: number; ino: number }) {
    return left.dev === right.dev && left.ino === right.ino;
}

async function inspectDirectDirectory(path: string): Promise<DirectDirectorySnapshot> {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(`Go state parent must be a direct directory: ${path}`);
    }
    assertOwned(metadata, 'Go state parent');
    return { canonicalPath: await realpath(path), dev: metadata.dev, ino: metadata.ino };
}

async function inspectDirectFile(path: string): Promise<DirectFileSnapshot> {
    const parent = await inspectDirectDirectory(dirname(path));
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error(`Go state must be a direct regular file: ${path}`);
    }
    assertOwned(metadata, 'Go state');
    const canonicalPath = await realpath(path);
    if (dirname(canonicalPath) !== parent.canonicalPath) {
        throw new Error('Go state must stay directly inside its run directory');
    }
    return { dev: metadata.dev, ino: metadata.ino, parent };
}

function assertSameDirectory(
    actual: DirectDirectorySnapshot,
    expected: DirectDirectorySnapshot,
): void {
    if (actual.canonicalPath !== expected.canonicalPath || !hasSameIdentity(actual, expected)) {
        throw new Error('Go state parent changed during the filesystem operation');
    }
}

function assertSameFile(actual: DirectFileSnapshot, expected: DirectFileSnapshot): void {
    assertSameDirectory(actual.parent, expected.parent);
    if (!hasSameIdentity(actual, expected)) {
        throw new Error('Go state target changed during the filesystem operation');
    }
}

async function readDirectFile(path: string, expected?: DirectFileSnapshot): Promise<string> {
    const before = expected ?? (await inspectDirectFile(path));
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const opened = await handle.stat();
        if (!hasSameIdentity(opened, before)) {
            throw new Error('Go state target changed before it could be opened');
        }
        const source = await handle.readFile('utf8');
        assertSameFile(await inspectDirectFile(path), before);
        return source;
    } finally {
        await handle.close();
    }
}

async function writeExclusiveFile(path: string, source: string): Promise<DirectFileSnapshot> {
    const parent = await inspectDirectDirectory(dirname(path));
    const handle = await open(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
    );
    try {
        await handle.writeFile(source, 'utf8');
        await handle.sync();
        const opened = await handle.stat();
        const written = await inspectDirectFile(path);
        assertSameDirectory(written.parent, parent);
        if (!hasSameIdentity(opened, written)) {
            throw new Error('Go state temporary file changed while it was open');
        }
        return written;
    } finally {
        await handle.close();
    }
}

function ensureStatePath(path: string): string {
    const absolutePath = resolve(path);
    const relativePath = relative(resolve(STATE_ROOT), absolutePath);
    if (
        relativePath === '' ||
        relativePath === '..' ||
        relativePath.startsWith(`..${sep}`) ||
        isAbsolute(relativePath)
    ) {
        throw new Error(`State path must stay under ${relative(PROJECT_ROOT, STATE_ROOT)}`);
    }
    return absolutePath;
}

async function ensureDirectDirectory(path: string): Promise<void> {
    try {
        const metadata = await lstat(path);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
            throw new Error(`Go state directory must not contain symbolic links: ${path}`);
        }
        assertOwned(metadata, 'Go state directory');
    } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
        await mkdir(path);
    }
}

async function assertDirectStateDirectory(path: string): Promise<void> {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(`Go state directory must not contain symbolic links: ${path}`);
    }
    assertOwned(metadata, 'Go state directory');
}

async function validateStateRoot(): Promise<string> {
    await Promise.all([RECORDS_ROOT, STATE_ROOT].map((path) => assertDirectStateDirectory(path)));
    const [canonicalProjectRoot, canonicalStateRoot] = await Promise.all([
        realpath(PROJECT_ROOT),
        realpath(STATE_ROOT),
    ]);
    if (canonicalStateRoot !== join(canonicalProjectRoot, '.records', 'go')) {
        throw new Error('Go state directory must stay inside the project');
    }
    return canonicalStateRoot;
}

async function ensureStateRoot(): Promise<string> {
    await ensureDirectDirectory(RECORDS_ROOT);
    await ensureDirectDirectory(STATE_ROOT);
    return validateStateRoot();
}

export function statePathForRunId(runId: string): string {
    if (!runId || runId === '.' || runId === '..' || runId.includes('/') || runId.includes('\\')) {
        throw new Error('Go run ID must be a single path segment');
    }
    return ensureStatePath(resolve(STATE_ROOT, runId, 'state.json'));
}

export async function resolveStatePath(supplied: string): Promise<string> {
    const path = ensureStatePath(resolve(PROJECT_ROOT, supplied));
    const canonicalStateRoot = await validateStateRoot();
    const logicalRelativePath = relative(resolve(STATE_ROOT), path);
    const logicalSegments = logicalRelativePath.split(sep);
    if (logicalSegments.length !== 2 || basename(path) !== 'state.json') {
        throw new Error('State path must identify one direct .records/go/<run-id>/state.json');
    }
    const snapshot = await inspectDirectFile(path);
    if (dirname(snapshot.parent.canonicalPath) !== canonicalStateRoot) {
        throw new Error('Go run directory must stay directly under .records/go');
    }
    return path;
}

export async function readState(path: string): Promise<GoState> {
    const snapshot = await inspectDirectFile(path);
    const raw: unknown = JSON.parse(await readDirectFile(path, snapshot));
    const state = validateState(raw);
    await verifyLedgerRetention(path, state, snapshot.parent.canonicalPath);
    const runDirectory = dirname(path);
    await verifyHandoffReportArtifact(state, runDirectory);
    const isRecoveredFinalizationDelivery = await wasFinalizationArtifactRecovered(
        state,
        runDirectory,
    );
    assertSameFile(await inspectDirectFile(path), snapshot);
    if (isRecoveredFinalizationDelivery) await writeState(path, state);
    return state;
}

export async function writeState(path: string, state: GoState): Promise<void> {
    const target = await inspectDirectFile(path);
    state.updatedAt = now();
    validateState(state);
    const previousArchive = await applyLedgerRetention(path, state, target.parent.canonicalPath);
    validateState(state);
    assertSameFile(await inspectDirectFile(path), target);

    const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    try {
        const replacement = await writeExclusiveFile(
            temporary,
            `${JSON.stringify(state, null, 2)}\n`,
        );
        assertSameFile(await inspectDirectFile(path), target);
        assertSameDirectory(replacement.parent, target.parent);
        await rename(temporary, path);
        const written = await inspectDirectFile(path);
        assertSameDirectory(written.parent, target.parent);
        if (!hasSameIdentity(written, replacement)) {
            throw new Error('Go state replacement did not preserve the exclusive temporary file');
        }
    } finally {
        await rm(temporary, { force: true });
    }
    if (previousArchive) {
        await rm(join(dirname(path), previousArchive), { force: true });
    }
}

export async function writeInitialState(path: string, state: GoState): Promise<void> {
    state.updatedAt = now();
    validateState(state);
    try {
        await writeExclusiveFile(path, `${JSON.stringify(state, null, 2)}\n`);
    } catch (error: unknown) {
        if (errorCode(error) === 'EEXIST') {
            throw new Error(`Go run already exists: ${path}`, { cause: error });
        }
        throw error;
    }
}

export async function withStateLock<T>(path: string, action: () => Promise<T>): Promise<T> {
    const target = await inspectDirectFile(path);
    const lockPath = join(dirname(path), 'state.lock');
    try {
        await mkdir(lockPath, { mode: 0o700 });
    } catch (error: unknown) {
        if (errorCode(error) === 'EEXIST')
            throw new Error('Go state is already locked by another writer', { cause: error });
        throw asError(error);
    }
    const lock = await inspectDirectDirectory(lockPath);
    assertSameDirectory(await inspectDirectDirectory(dirname(lockPath)), target.parent);
    let result: T | undefined;
    let actionError: unknown;
    try {
        result = await action();
    } catch (error: unknown) {
        actionError = error;
    }
    let releaseError: unknown;
    try {
        const currentParent = await inspectDirectDirectory(dirname(path));
        assertSameDirectory(currentParent, target.parent);
        const currentLock = await inspectDirectDirectory(lockPath);
        if (!hasSameIdentity(currentLock, lock)) {
            throw new Error('Go state writer lock ownership changed before release');
        }
        await rmdir(lockPath);
    } catch (error: unknown) {
        releaseError = error;
    }
    if (actionError && releaseError) {
        throw new AggregateError(
            [actionError, releaseError],
            'Go state command and writer-lock release both failed',
        );
    }
    if (actionError) throw asError(actionError);
    if (releaseError) throw asError(releaseError);
    return result as T;
}

export async function prepareRunDirectory(path: string): Promise<void> {
    const canonicalStateRoot = await ensureStateRoot();
    const runDirectory = dirname(path);
    try {
        await mkdir(runDirectory);
    } catch (error: unknown) {
        if (errorCode(error) !== 'EEXIST') throw error;
        const metadata = await lstat(runDirectory);
        if (metadata.isSymbolicLink()) {
            throw new Error('Go run directory must not be a symbolic link', { cause: error });
        }
        throw new Error(`Go run already exists: ${path}`, { cause: error });
    }
    const canonicalRunDirectory = await realpath(runDirectory);
    if (dirname(canonicalRunDirectory) !== canonicalStateRoot) {
        throw new Error('Go run directory must stay directly under the Go state directory');
    }
    await Promise.all(RUN_DIRECTORIES.map((name) => mkdir(join(runDirectory, name))));
}

export function runDirectoryForStatePath(path: string): string {
    return dirname(path);
}
