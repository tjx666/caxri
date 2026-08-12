import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyFinalizationArtifact } from './finalization';
import { verifyHandoffReportArtifact } from './handoff-report';
import { now, type GoState, validateState } from './state-model';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
export const PROJECT_ROOT = resolve(dirname(SCRIPT_PATH), '../../../..');
const RECORDS_ROOT = join(PROJECT_ROOT, '.records');
const STATE_ROOT = join(RECORDS_ROOT, 'go');
const RUN_DIRECTORIES = ['reviews', 'validation', 'ci-artifacts', 'acceptance'] as const;

function errorCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
    return typeof error.code === 'string' ? error.code : undefined;
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
    } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
        await mkdir(path);
    }
}

async function validateStateRoot(): Promise<string> {
    for (const path of [RECORDS_ROOT, STATE_ROOT]) {
        const metadata = await lstat(path);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
            throw new Error(`Go state directory must not contain symbolic links: ${path}`);
        }
    }
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
    const runDirectory = dirname(path);
    const [runMetadata, stateMetadata] = await Promise.all([lstat(runDirectory), lstat(path)]);
    if (runMetadata.isSymbolicLink() || !runMetadata.isDirectory()) {
        throw new Error('Go run directory must be a direct directory, not a symbolic link');
    }
    if (stateMetadata.isSymbolicLink() || !stateMetadata.isFile()) {
        throw new Error('Go state must be a direct regular file, not a symbolic link');
    }
    const canonicalRunDirectory = await realpath(runDirectory);
    if (dirname(canonicalRunDirectory) !== canonicalStateRoot) {
        throw new Error('Go run directory must stay directly under .records/go');
    }
    const canonicalPath = await realpath(path);
    if (dirname(canonicalPath) !== canonicalRunDirectory) {
        throw new Error('Go state must stay directly inside its run directory');
    }
    return canonicalPath;
}

export async function readState(path: string): Promise<GoState> {
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
    const state = validateState(raw);
    const runDirectory = dirname(path);
    await verifyHandoffReportArtifact(state, runDirectory);
    const recoveredFinalizationDelivery = await verifyFinalizationArtifact(state, runDirectory);
    if (recoveredFinalizationDelivery) await writeState(path, state);
    return state;
}

export async function writeState(path: string, state: GoState): Promise<void> {
    state.updatedAt = now();
    validateState(state);
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temporary, path);
}

export async function writeInitialState(path: string, state: GoState): Promise<void> {
    state.updatedAt = now();
    validateState(state);
    await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
    }).catch((error: unknown) => {
        if (errorCode(error) === 'EEXIST') throw new Error(`Go run already exists: ${path}`);
        throw error;
    });
}

export async function prepareRunDirectory(path: string): Promise<void> {
    const canonicalStateRoot = await ensureStateRoot();
    const runDirectory = dirname(path);
    try {
        await mkdir(runDirectory);
    } catch (error: unknown) {
        if (errorCode(error) !== 'EEXIST') throw error;
        const metadata = await lstat(runDirectory);
        if (metadata.isSymbolicLink())
            throw new Error('Go run directory must not be a symbolic link', { cause: error });
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
