import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buffer } from 'node:stream/consumers';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureLocalRuntime, gzipProgressStream, progressStream, readRemoteLayer } from '../layers';
import { buildLayerFixture, makeShortTemporaryDirectory, sha256 } from './support/fixtures';

const execFileAsync = promisify(execFile);

describe('remote layers', () => {
    let root: string;

    beforeEach(async () => {
        root = await makeShortTemporaryDirectory('lay');
    });

    afterEach(async () => {
        await rm(root, { force: true, recursive: true });
    });

    describe('readRemoteLayer', () => {
        it('reads a valid descriptor and its application tarball', async () => {
            const fixture = await buildLayerFixture(root, { architecture: 'arm64' });
            const layer = await readRemoteLayer(root, 'arm64');
            expect(layer.descriptor).toEqual(fixture.descriptor);
            expect(layer.appPath).toBe(join(root, 'linux-arm64', 'app.tar.gz'));
        });

        it('reports a missing architecture as not found', async () => {
            await buildLayerFixture(root, { architecture: 'arm64' });
            await expect(readRemoteLayer(root, 'x64')).rejects.toMatchObject({ code: 'NOT_FOUND' });
        });

        it('refuses invalid descriptors and size mismatches', async () => {
            const fixture = await buildLayerFixture(root);
            const path = join(root, 'linux-x64', 'descriptor.json');
            await writeFile(path, JSON.stringify({ ...fixture.descriptor, target: 'linux-arm64' }));
            await expect(readRemoteLayer(root, 'x64')).rejects.toMatchObject({
                code: 'VALIDATION',
            });
            await writeFile(
                path,
                JSON.stringify({
                    ...fixture.descriptor,
                    runtime: { ...fixture.descriptor.runtime, path: '../node' },
                }),
            );
            await expect(readRemoteLayer(root, 'x64')).rejects.toMatchObject({
                code: 'VALIDATION',
            });
            await writeFile(
                path,
                JSON.stringify({
                    ...fixture.descriptor,
                    runtime: {
                        ...fixture.descriptor.runtime,
                        source: {
                            ...fixture.descriptor.runtime.source,
                            url: 'file:///tmp/node.tar.gz',
                        },
                    },
                }),
            );
            await expect(readRemoteLayer(root, 'x64')).rejects.toMatchObject({
                code: 'VALIDATION',
            });
            await writeFile(
                path,
                JSON.stringify({
                    ...fixture.descriptor,
                    app: { ...fixture.descriptor.app, bytes: fixture.descriptor.app.bytes + 1 },
                }),
            );
            await expect(readRemoteLayer(root, 'x64')).rejects.toMatchObject({ code: 'NOT_FOUND' });
        });
    });

    describe('ensureLocalRuntime', () => {
        const member = 'node-v0.0.0-linux-x64/bin/node';
        const content = Buffer.from('fake node binary');

        async function archive(): Promise<Buffer> {
            const staging = join(root, 'staging');
            await mkdir(join(staging, 'node-v0.0.0-linux-x64', 'bin'), { recursive: true });
            await writeFile(join(staging, member), content);
            const path = join(root, 'node.tar.gz');
            await execFileAsync('tar', ['-czf', path, '-C', staging, 'node-v0.0.0-linux-x64']);
            return readFile(path);
        }

        function runtimeFor(archiveBytes: Buffer, overrides: { sha256?: string } = {}) {
            return {
                bytes: content.length,
                path: 'runtime/bin/node',
                sha256: overrides.sha256 ?? sha256(content),
                source: {
                    member,
                    sha256: sha256(archiveBytes),
                    url: 'https://nodejs.org/dist/v0.0.0/node-v0.0.0-linux-x64.tar.gz',
                },
            };
        }

        it('downloads, verifies, caches, and then reuses the runtime', async () => {
            const bytes = await archive();
            let fetches = 0;
            const fetchImplementation = (() => {
                fetches += 1;
                return Promise.resolve(new Response(new Uint8Array(bytes)));
            }) as unknown as typeof fetch;
            const cacheDirectory = join(root, 'cache');
            const runtime = runtimeFor(bytes);
            const path = await ensureLocalRuntime({ cacheDirectory, fetchImplementation, runtime });
            expect(path).toBe(join(cacheDirectory, sha256(content), 'node'));
            expect(await readFile(path)).toEqual(content);
            await ensureLocalRuntime({ cacheDirectory, fetchImplementation, runtime });
            expect(fetches).toBe(1);
        });

        it('refuses a failed download and checksum mismatches without caching', async () => {
            const bytes = await archive();
            const cacheDirectory = join(root, 'cache');
            const failing = (() =>
                Promise.resolve(new Response('nope', { status: 404 }))) as unknown as typeof fetch;
            await expect(
                ensureLocalRuntime({
                    cacheDirectory,
                    fetchImplementation: failing,
                    runtime: runtimeFor(bytes),
                }),
            ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
            const otherSha = sha256('other');
            const serving = (() =>
                Promise.resolve(new Response(new Uint8Array(bytes)))) as unknown as typeof fetch;
            await expect(
                ensureLocalRuntime({
                    cacheDirectory,
                    fetchImplementation: serving,
                    runtime: runtimeFor(bytes, { sha256: otherSha }),
                }),
            ).rejects.toMatchObject({ code: 'VALIDATION' });
            await expect(
                ensureLocalRuntime({
                    cacheDirectory,
                    fetchImplementation: serving,
                    runtime: {
                        ...runtimeFor(bytes),
                        source: { ...runtimeFor(bytes).source, sha256: sha256('x') },
                    },
                }),
            ).rejects.toMatchObject({ code: 'VALIDATION' });
        });
    });

    describe('progress streams', () => {
        it('counts source bytes and gzip-compresses the runtime stream', async () => {
            const path = join(root, 'payload');
            const payload = Buffer.alloc(256 * 1024, 7);
            await writeFile(path, payload);
            let counted = 0;
            expect(await buffer(progressStream(path, (bytes) => (counted += bytes)))).toEqual(
                payload,
            );
            expect(counted).toBe(payload.length);
            counted = 0;
            const compressed = await buffer(
                gzipProgressStream(path, (bytes) => (counted += bytes)),
            );
            expect(gunzipSync(compressed)).toEqual(payload);
            expect(counted).toBe(payload.length);
        });
    });
});
