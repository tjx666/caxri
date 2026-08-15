import { lstat, mkdir, realpath, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
export const PROJECT_ROOT = resolve(dirname(SCRIPT_PATH), '../../../..');
export const RECORDS_ROOT = join(PROJECT_ROOT, '.records');

export function errorCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
    return typeof error.code === 'string' ? error.code : undefined;
}

export function isInside(parent: string, candidate: string): boolean {
    const path = relative(parent, candidate);
    return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export function resolveReportDirectory(path: string): string {
    const directory = resolve(PROJECT_ROOT, path);
    if (!isInside(RECORDS_ROOT, directory)) {
        throw new Error('Acceptance report directory must stay under .records/');
    }
    if (!/^round-[1-9]\d*$/.test(basename(directory))) {
        throw new Error('Acceptance report directory must end with round-<positive integer>');
    }
    return directory;
}

async function ensureDirectDirectory(path: string): Promise<void> {
    try {
        const metadata = await lstat(path);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
            throw new Error(
                `Acceptance report path must not contain symbolic links: ${relative(PROJECT_ROOT, path)}`,
            );
        }
    } catch (error: unknown) {
        if (errorCode(error) !== 'ENOENT') throw error;
        await mkdir(path);
    }
}

export async function validateRecordsRoot(): Promise<string> {
    const metadata = await lstat(RECORDS_ROOT);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error('Acceptance report path must not contain symbolic links: .records');
    }
    const [canonicalProjectRoot, canonicalRecordsRoot] = await Promise.all([
        realpath(PROJECT_ROOT),
        realpath(RECORDS_ROOT),
    ]);
    if (canonicalRecordsRoot !== join(canonicalProjectRoot, '.records')) {
        throw new Error('Acceptance report directory must stay under .records/');
    }
    return canonicalRecordsRoot;
}

export async function prepareReportParent(directory: string): Promise<string> {
    await ensureDirectDirectory(RECORDS_ROOT);
    const parent = dirname(directory);
    const parentSegments = relative(RECORDS_ROOT, parent).split(sep).filter(Boolean);
    let current = RECORDS_ROOT;
    for (const segment of parentSegments) {
        current = join(current, segment);
        // Each segment must be created and validated top-down before descending into it,
        // since creating a directory depends on its parent already existing on disk.
        // eslint-disable-next-line no-await-in-loop
        await ensureDirectDirectory(current);
    }
    const canonicalRecordsRoot = await validateRecordsRoot();
    const canonicalParent = await realpath(parent);
    if (!isInside(canonicalRecordsRoot, canonicalParent)) {
        throw new Error('Acceptance report directory must stay under .records/');
    }
    return parent;
}

export async function validateExistingReportDirectory(path: string): Promise<string> {
    const directory = resolveReportDirectory(path);
    await validateRecordsRoot();
    const segments = relative(RECORDS_ROOT, directory).split(sep);
    let current = RECORDS_ROOT;
    for (const segment of segments) {
        current = join(current, segment);
        // Each path segment must be checked top-down so a symbolic link is caught at the
        // first point it appears, before descending through it to check deeper segments.
        // eslint-disable-next-line no-await-in-loop
        const metadata = await lstat(current);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
            throw new Error(
                `Acceptance report path must not contain symbolic links: ${relative(PROJECT_ROOT, current)}`,
            );
        }
    }
    const [canonicalRecordsRoot, canonicalDirectory] = await Promise.all([
        realpath(RECORDS_ROOT),
        realpath(directory),
    ]);
    if (!isInside(canonicalRecordsRoot, canonicalDirectory)) {
        throw new Error('Acceptance report directory must stay under .records/');
    }
    return directory;
}

export async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporary, path);
}
