import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';

import type { ServerArtifactManifest } from '@caxri/protocol';
import { CaxriError, serverArtifactManifestSchema } from '@caxri/protocol';

const MAX_MANIFEST_BYTES = 1024 * 1024;

export interface ServerArtifactDescriptor {
    bundleDirectory: string;
    entryPath: string;
    executablePath: string;
    manifest: ServerArtifactManifest;
    rootPath: string;
}

function resolveInside(root: string, path: string): string {
    const candidate = resolve(root, path);
    const nested = relative(root, candidate);
    if (
        nested === '..' ||
        isAbsolute(nested) ||
        nested.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    ) {
        throw new Error('Server artifact manifest path escapes its root');
    }
    return candidate;
}

async function readManifest(path: string): Promise<unknown> {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const metadata = await file.stat();
        if (!metadata.isFile() || metadata.size > MAX_MANIFEST_BYTES) {
            throw new Error('Server artifact manifest must be a bounded regular file');
        }
        // eslint-disable-next-line unicorn/consistent-json-file-read -- the opened O_NOFOLLOW handle is the security boundary
        const source = await file.readFile({ encoding: 'utf8' });
        return JSON.parse(source) as unknown;
    } finally {
        await file.close();
    }
}

async function assertLaunchFile(path: string, shouldBeExecutable: boolean): Promise<void> {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(`Server artifact launch input is not a regular file: ${path}`);
    }
    if (shouldBeExecutable && process.platform !== 'win32' && (metadata.mode & 0o111) === 0) {
        throw new Error(`Server artifact runtime is not executable: ${path}`);
    }
}

export async function resolveServerArtifact(root: string): Promise<ServerArtifactDescriptor> {
    try {
        const rootPath = await realpath(root);
        const manifest = serverArtifactManifestSchema.parse(
            await readManifest(join(rootPath, 'metadata', 'manifest.json')),
        );
        if (manifest.platform !== process.platform || manifest.architecture !== process.arch) {
            throw new CaxriError('CONFLICT', 'Server artifact platform is incompatible', {
                artifactArchitecture: manifest.architecture,
                artifactPlatform: manifest.platform,
                processArchitecture: process.arch,
                processPlatform: process.platform,
            });
        }
        const executablePath = resolveInside(rootPath, manifest.runtime.executable);
        const entryPath = resolveInside(rootPath, manifest.entrypoints.server);
        await Promise.all([
            assertLaunchFile(executablePath, true),
            assertLaunchFile(entryPath, false),
        ]);
        return {
            bundleDirectory: resolveInside(rootPath, 'bundles'),
            entryPath,
            executablePath,
            manifest,
            rootPath,
        };
    } catch (error) {
        if (error instanceof CaxriError) throw error;
        throw new CaxriError('UNAVAILABLE', 'Server artifact manifest is invalid', {
            reason: error instanceof Error ? error.message : 'Unknown artifact error',
        });
    }
}
