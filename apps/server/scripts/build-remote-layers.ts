#!/usr/bin/env bun

import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { computeBuildFingerprint } from '@caxri/system';

import { verifyServerArtifact } from './artifact';
import { LINUX_GLIBC_BASELINE } from './linux-target';
import type { RemoteLayerDescriptor } from './remote-layer';
import { APP_LAYER_FILE, buildAppLayer, REMOTE_RUNTIME_PATH } from './remote-layer';
import type { RemoteTarget } from './remote-target';
import { MACOS_BASELINE, parseRemoteTargets } from './remote-target';

const execFileAsync = promisify(execFile);
const serverRoot = resolve(import.meta.dirname, '..');

/**
 * Builds the SSH Host upload layers: for each target, assembles the target Server artifact and writes
 * `dist/remote/<target>/{app.tar.gz,descriptor.json}`, which packaging embeds under `Contents/Resources/remote`. Usage:
 * `bun run scripts/build-remote-layers.ts [--target linux-x64] [--target linux-arm64] [--target darwin-arm64]`
 * (default: both Linux targets, plus `darwin-arm64` on an Apple silicon Mac).
 */
async function buildTarget(target: RemoteTarget): Promise<RemoteLayerDescriptor> {
    process.stdout.write(`Building ${target} Server artifact\n`);
    await execFileAsync('bun', ['run', 'scripts/build-artifact.ts', '--target', target], {
        cwd: serverRoot,
        maxBuffer: 16 * 1024 * 1024,
    });
    const artifactRoot = resolve(serverRoot, 'dist/targets', target, 'server');
    const manifest = await verifyServerArtifact(artifactRoot);
    const source = manifest.runtime.source;
    if (!source) throw new Error(`${target} artifact manifest has no runtime source`);
    const runtime = manifest.integrity.files.find((file) => file.path === REMOTE_RUNTIME_PATH);
    if (!runtime) throw new Error(`${target} artifact has no ${REMOTE_RUNTIME_PATH}`);
    const fingerprint = await computeBuildFingerprint(join(artifactRoot, 'bundles'));
    if (!fingerprint) throw new Error(`${target} artifact bundles are unreadable`);
    // The remote Server must report the same generation as the Desktop that installed it, or every attach would look
    // stale. Both come from the same `dist/bundles`, so a mismatch means the inputs moved during the build.
    const localFingerprint = await computeBuildFingerprint(resolve(serverRoot, 'dist/bundles'));
    if (localFingerprint !== fingerprint)
        throw new Error(
            `${target} fingerprint ${fingerprint} differs from the local bundles (${localFingerprint})`,
        );

    const outputDirectory = resolve(serverRoot, 'dist/remote', target);
    await rm(outputDirectory, { force: true, recursive: true });
    await mkdir(outputDirectory, { recursive: true });
    const app = await buildAppLayer(artifactRoot, join(outputDirectory, APP_LAYER_FILE));
    const descriptor: RemoteLayerDescriptor = {
        schemaVersion: 1,
        target,
        buildId: manifest.integrity.aggregateSha256.slice(0, 16),
        fingerprint,
        version: manifest.version,
        commit: manifest.commit,
        systemBaseline: target === 'darwin-arm64' ? MACOS_BASELINE : LINUX_GLIBC_BASELINE,
        app: { file: APP_LAYER_FILE, sha256: app.sha256, bytes: app.bytes },
        runtime: {
            sha256: runtime.sha256,
            bytes: runtime.size,
            path: REMOTE_RUNTIME_PATH,
            source: { url: source.url, sha256: source.sha256, member: source.member },
        },
    };
    await writeFile(
        join(outputDirectory, 'descriptor.json'),
        `${JSON.stringify(descriptor, null, 2)}\n`,
    );
    process.stdout.write(
        `Wrote ${target} layer ${descriptor.buildId}: ${app.files} files, ${app.bytes} bytes compressed; runtime ${runtime.size} bytes\n`,
    );
    return descriptor;
}

if (import.meta.main) {
    const explicit = process.argv.includes('--target');
    const targets = parseRemoteTargets(process.argv.slice(2));
    // Packaging copies all of `dist/remote`; any multi-target build starts clean so a layer from another commit cannot ship.
    if (!explicit || targets.length > 1)
        await rm(resolve(serverRoot, 'dist/remote'), { force: true, recursive: true });
    for (const target of targets) {
        // eslint-disable-next-line no-await-in-loop -- targets share the native staging cache and Docker
        await buildTarget(target);
    }
}
