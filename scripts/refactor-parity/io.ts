import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, readdir, readFile, readlink, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';

import { writeJsonAtomic } from '../atomic-json';
import type { ArtifactFileReceipt, RefactorBaselineManifest } from './contracts';

function compareCodeUnits(left: string, right: string): number {
    if (left === right) return 0;
    return left < right ? -1 : 1;
}

export async function readJson(path: string): Promise<unknown> {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error(`JSON input must be a regular file: ${path}`);
    }
    if (metadata.size > 10 * 1024 * 1024) throw new Error(`JSON input exceeds 10 MiB: ${path}`);
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

export async function sha256File(path: string): Promise<string> {
    const digest = createHash('sha256');
    await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(path);
        stream.on('data', (chunk) => digest.update(chunk));
        stream.once('error', reject);
        stream.once('end', resolve);
    });
    return digest.digest('hex');
}

async function walkFiles(root: string, current = root): Promise<string[]> {
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink() || metadata.isFile()) return [current];
    if (!metadata.isDirectory())
        throw new Error(`Artifact contains an unsupported entry: ${current}`);
    const entries = await readdir(current);
    const descendants = await Promise.all(
        entries.toSorted(compareCodeUnits).map((entry) => walkFiles(root, join(current, entry))),
    );
    return descendants.flat();
}

export async function hashArtifact(root: string): Promise<{
    aggregateSha256: string;
    files: ArtifactFileReceipt[];
}> {
    const rootMetadata = await lstat(root);
    if (rootMetadata.isSymbolicLink()) throw new Error('Artifact root must not be a symbolic link');
    const rootDirectory = rootMetadata.isDirectory() ? root : dirname(root);
    const files = await walkFiles(root);
    const receipts = await Promise.all(
        files.map(async (file): Promise<ArtifactFileReceipt> => {
            const metadata = await lstat(file);
            const target = metadata.isSymbolicLink() ? await readlink(file) : undefined;
            if (target !== undefined) {
                const resolvedTarget = resolve(dirname(file), target);
                const targetFromRoot = relative(rootDirectory, resolvedTarget);
                if (
                    targetFromRoot === '..' ||
                    isAbsolute(target) ||
                    targetFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
                ) {
                    throw new Error(`Artifact symbolic link escapes its root: ${file}`);
                }
            }
            return {
                kind: metadata.isSymbolicLink() ? 'symlink' : 'file',
                mode: metadata.mode & 0o777,
                path: rootMetadata.isDirectory() ? relative(rootDirectory, file) : basename(file),
                sha256:
                    target !== undefined
                        ? createHash('sha256').update(target).digest('hex')
                        : await sha256File(file),
                size: metadata.size,
                ...(target !== undefined && { target }),
            };
        }),
    );
    const sortedReceipts = receipts.toSorted((left, right) =>
        compareCodeUnits(left.path, right.path),
    );
    return {
        aggregateSha256: createHash('sha256').update(JSON.stringify(sortedReceipts)).digest('hex'),
        files: sortedReceipts,
    };
}

export async function archiveArtifact(
    source: string,
    destination: string,
): Promise<{
    aggregateSha256: string;
    files: ArtifactFileReceipt[];
}> {
    const sourceReceipt = await hashArtifact(source);
    await cp(source, destination, {
        errorOnExist: true,
        force: false,
        recursive: true,
        verbatimSymlinks: true,
    });
    const destinationReceipt = await hashArtifact(destination);
    if (JSON.stringify(sourceReceipt) !== JSON.stringify(destinationReceipt)) {
        throw new Error('Archived artifact does not match the source artifact');
    }
    return destinationReceipt;
}

export async function publishBaseline(
    outputRoot: string,
    baselineId: string,
    build: (temporaryDirectory: string) => Promise<RefactorBaselineManifest>,
): Promise<string> {
    if (!/^[a-z\d][a-z\d-]*$/u.test(baselineId)) {
        throw new Error('Baseline ID must be kebab-case');
    }
    const destination = join(outputRoot, baselineId);
    try {
        await lstat(destination);
        throw new Error(`Baseline already exists and is immutable: ${destination}`);
    } catch (error: unknown) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    await mkdir(outputRoot, { recursive: true });
    const temporaryDirectory = join(
        outputRoot,
        `.${baselineId}.${process.pid}.${randomUUID()}.tmp`,
    );
    await mkdir(temporaryDirectory, { mode: 0o700 });
    try {
        const manifest = await build(temporaryDirectory);
        await writeJsonAtomic(join(temporaryDirectory, 'manifest.json'), manifest, { mode: 0o600 });
        await rename(temporaryDirectory, destination);
        return destination;
    } finally {
        await rm(temporaryDirectory, { force: true, recursive: true });
    }
}

export async function verifyArtifactFiles(
    baselineDirectory: string,
    manifest: RefactorBaselineManifest,
): Promise<string[]> {
    const artifactPath = join(baselineDirectory, manifest.artifact.relativePath);
    try {
        const actual = await hashArtifact(artifactPath);
        const expected = {
            aggregateSha256: manifest.artifact.aggregateSha256,
            files: manifest.artifact.files,
        };
        return JSON.stringify(actual) === JSON.stringify(expected)
            ? []
            : ['Archived artifact hash or file metadata changed'];
    } catch (error: unknown) {
        return [error instanceof Error ? error.message : String(error)];
    }
}
