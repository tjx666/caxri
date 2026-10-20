import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fetchRuntimeScript, gcScript, installAppScript, uploadRuntimeScript } from '../scripts';
import type { LayerFixture } from './support/fixtures';
import { buildLayerFixture, sha256, writeShims } from './support/fixtures';
import { SshHostScriptHost } from './support/script-host';

const execFileAsync = promisify(execFile);

/**
 * The scripts that install and garbage-collect build layers and the Node runtime cache on the SSH Host.
 */
describe('remote install scripts', () => {
    let host: SshHostScriptHost;

    beforeEach(async () => {
        host = await SshHostScriptHost.create();
    });

    afterEach(async () => {
        await host.dispose();
    });

    describe('upload-runtime', () => {
        it('caches a verified runtime and refuses a corrupt one', async () => {
            const content = Buffer.from('#!/bin/sh\necho node\n');
            const sha = sha256(content);
            const corrupt = await host.run(
                uploadRuntimeScript({ runtimeSha256: sha }),
                gzipSync('tampered'),
            );
            expect(corrupt).toMatchObject({ code: 24 });
            expect(corrupt.result?.get('status')).toBe('checksum');
            expect(await host.listRemote('runtimes')).toEqual([]);

            const uploaded = await host.run(
                uploadRuntimeScript({ runtimeSha256: sha }),
                gzipSync(content),
            );
            expect(uploaded.result?.get('status')).toBe('installed');
            const node = join(host.serverRoot(), 'runtimes', sha, 'node');
            expect((await stat(node)).mode & 0o777).toBe(0o755);
            expect(await readFile(node, 'utf8')).toBe(content.toString());

            const again = await host.run(
                uploadRuntimeScript({ runtimeSha256: sha }),
                gzipSync(content),
            );
            expect(again.result?.get('status')).toBe('present');
        });

        it('verifies with shasum where sha256sum is not on PATH', async () => {
            // macOS keeps `sha256sum` in /sbin, so dropping /sbin exercises the `shasum -a 256` fallback there.
            host.environment = { ...host.environment, PATH: `${host.shims}:/usr/bin:/bin` };
            const content = Buffer.from('runtime');
            const uploaded = await host.run(
                uploadRuntimeScript({ runtimeSha256: sha256(content) }),
                gzipSync(content),
            );
            expect(uploaded.result?.get('status')).toBe('installed');
            const corrupt = await host.run(
                uploadRuntimeScript({ runtimeSha256: sha256('other') }),
                gzipSync(content),
            );
            expect(corrupt.result?.get('status')).toBe('checksum');
        });
    });

    describe('install-app', () => {
        let layers: string;
        let fixture: LayerFixture;

        beforeEach(async () => {
            layers = join(host.root, 'layers');
            fixture = await buildLayerFixture(layers);
        });

        const install = async (
            archive: Buffer,
            overrides: { appSha256?: string } = {},
        ): Promise<{ code: number | null; status: string | undefined }> => {
            const output = await host.run(
                installAppScript({
                    appSha256: overrides.appSha256 ?? sha256(archive),
                    buildId: fixture.descriptor.buildId,
                    runtimePath: fixture.descriptor.runtime.path,
                    runtimeSha256: fixture.descriptor.runtime.sha256,
                }),
                archive,
            );
            return { code: output.code, status: output.result?.get('status') };
        };

        const appArchive = (): Promise<Buffer> => readFile(join(layers, 'linux-x64', 'app.tar.gz'));

        const retar = async (): Promise<Buffer> => {
            const path = join(host.root, 'retarred.tar.gz');
            await execFileAsync('tar', ['-czf', path, '-C', fixture.stagingDirectory, '.']);
            return readFile(path);
        };

        it('requires the runtime first', async () => {
            expect(await install(await appArchive())).toEqual({
                code: 3,
                status: 'runtime-missing',
            });
        });

        it('installs with a hard-linked runtime and reports present afterwards', async () => {
            await host.installRuntime(fixture);
            expect(await install(await appArchive())).toEqual({ code: 0, status: 'installed' });
            const build = join(host.serverRoot(), 'builds', fixture.descriptor.buildId);
            const runtime = join(
                host.serverRoot(),
                'runtimes',
                fixture.descriptor.runtime.sha256,
                'node',
            );
            expect((await stat(join(build, 'runtime/bin/node'))).ino).toBe(
                (await stat(runtime)).ino,
            );
            expect(await readFile(join(build, '.caxri-runtime'), 'utf8')).toBe(
                `${fixture.descriptor.runtime.sha256}\n`,
            );
            await stat(join(build, '.caxri-complete'));
            expect(await install(await appArchive())).toEqual({ code: 0, status: 'present' });
            const leftovers = (await host.listRemote('builds')).filter((name) =>
                name.startsWith('.tmp-'),
            );
            expect(leftovers).toEqual([]);
            await expect(stat(host.remotePath('install.lock'))).rejects.toThrow();
        });

        it('rejects an archive whose hash does not match', async () => {
            await host.installRuntime(fixture);
            expect(await install(await appArchive(), { appSha256: sha256('other') })).toEqual({
                code: 4,
                status: 'archive-checksum',
            });
            expect(await host.listRemote('builds')).toEqual([]);
        });

        it('rejects a modified file and an unlisted file', async () => {
            await host.installRuntime(fixture);
            await writeFile(join(fixture.stagingDirectory, 'bundles/server-core.js'), 'tampered');
            expect(await install(await retar())).toEqual({ code: 6, status: 'checksum' });

            fixture = await buildLayerFixture(join(host.root, 'layers-2'));
            await writeFile(join(fixture.stagingDirectory, 'bundles/extra.js'), 'unlisted');
            expect(await install(await retar())).toEqual({ code: 6, status: 'checksum' });
            expect(await host.listRemote('builds')).toEqual([]);
        });

        it('rejects garbage that is not a tarball', async () => {
            await host.installRuntime(fixture);
            expect(await install(Buffer.from('not a tarball'))).toEqual({
                code: 5,
                status: 'extract',
            });
        });

        it('breaks a stale lock left by a dead installer', async () => {
            await host.installRuntime(fixture);
            await mkdir(join(host.serverRoot(), 'install.lock'));
            await writeFile(join(host.serverRoot(), 'install.lock', 'pid'), '999999\n');
            expect(await install(await appArchive())).toEqual({ code: 0, status: 'installed' });
        });
    });

    describe('fetch-runtime', () => {
        const member = 'node-v0.0.0-linux-x64/bin/node';
        const content = Buffer.from('#!/bin/sh\necho downloaded\n');

        async function makeArchive(format: 'gz' | 'xz'): Promise<string> {
            const staging = join(host.root, `archive-${format}`);
            await mkdir(join(staging, 'node-v0.0.0-linux-x64', 'bin'), { recursive: true });
            await writeFile(join(staging, member), content, { mode: 0o755 });
            const archive = join(host.root, `node.tar.${format}`);
            await execFileAsync('tar', [
                format === 'gz' ? '-czf' : '-cJf',
                archive,
                '-C',
                staging,
                '.',
            ]);
            return archive;
        }

        /**
         * A `curl` that "downloads" a local file by copying it to the `-o` target.
         */
        async function curlServing(path: string): Promise<void> {
            await writeShims(host.shims, {
                curl: `while [ $# -gt 0 ]; do if [ "$1" = -o ]; then out="$2"; shift; fi; shift; done\ncp ${JSON.stringify(path)} "$out"`,
            });
        }

        it.each(['gz', 'xz'] as const)(
            'downloads, verifies, and caches a tar.%s runtime',
            async (format) => {
                const archive = await makeArchive(format);
                await curlServing(archive);
                const script = fetchRuntimeScript({
                    member: `./${member}`.slice(2),
                    runtimeSha256: sha256(content),
                    sha256: sha256(await readFile(archive)),
                    url: `https://nodejs.org/dist/v0.0.0/node-v0.0.0-linux-x64.tar.${format}`,
                });
                const fetched = await host.run(script);
                const contentSha = sha256(content);
                expect(fetched.result?.get('status')).toBe('installed');
                expect(
                    await readFile(host.remotePath('runtimes', contentSha, 'node'), 'utf8'),
                ).toBe(content.toString());
                expect((await host.run(script)).result?.get('status')).toBe('present');
            },
        );

        it('reports download and checksum failures without caching', async () => {
            const archive = await makeArchive('gz');
            const input = {
                member,
                runtimeSha256: sha256(content),
                sha256: sha256(await readFile(archive)),
                url: 'https://nodejs.org/dist/v0.0.0/node-v0.0.0-linux-x64.tar.gz',
            };
            const failed = await host.run(fetchRuntimeScript(input));
            expect(failed).toMatchObject({ code: 20 });

            await curlServing(archive);
            const wrongArchive = await host.run(
                fetchRuntimeScript({ ...input, sha256: sha256('x') }),
            );
            expect(wrongArchive).toMatchObject({ code: 22 });
            const wrongBinary = await host.run(
                fetchRuntimeScript({ ...input, runtimeSha256: sha256('x') }),
            );
            expect(wrongBinary).toMatchObject({ code: 24 });
            const missingMember = await host.run(
                fetchRuntimeScript({ ...input, member: 'missing/node' }),
            );
            expect(missingMember).toMatchObject({ code: 23 });
            expect(await host.listRemote('runtimes')).toEqual([]);
        });
    });
    describe('gc', () => {
        const current = 'aaaaaaaaaaaaaaaa';
        const previous = 'bbbbbbbbbbbbbbbb';
        const older = 'cccccccccccccccc';
        const incomplete = 'dddddddddddddddd';
        const runtimes = { keep: '11', previous: '22', orphan: '33' };

        async function makeBuild(
            id: string,
            runtime: string,
            ageSeconds: number,
            isComplete = true,
        ) {
            const directory = join(host.serverRoot(), 'builds', id);
            await mkdir(directory, { recursive: true });
            await writeFile(join(directory, '.caxri-runtime'), `${runtime}\n`);
            if (isComplete) await writeFile(join(directory, '.caxri-complete'), '');
            const time = Date.now() / 1000 - ageSeconds;
            await utimes(directory, time, time);
        }

        beforeEach(async () => {
            for (const sha of Object.values(runtimes))
                // eslint-disable-next-line no-await-in-loop -- tiny fixture.
                await mkdir(join(host.serverRoot(), 'runtimes', sha), { recursive: true });
        });

        it('keeps the current and the latest previous build and their runtimes', async () => {
            await makeBuild(current, runtimes.keep, 0);
            await makeBuild(incomplete, runtimes.orphan, 50, false);
            await makeBuild(previous, runtimes.previous, 100);
            await makeBuild(older, runtimes.orphan, 200);
            const staleTemporary = join(host.serverRoot(), 'builds', '.tmp-old');
            await mkdir(staleTemporary);
            const old = Date.now() / 1000 - 7200;
            await utimes(staleTemporary, old, old);

            const collected = await host.run(
                gcScript({ buildId: current, runtimeSha256: runtimes.keep }),
            );
            expect(collected.result?.get('removedBuilds')).toBe('2');
            expect(collected.result?.get('removedRuntimes')).toBe('1');
            expect(await host.listRemote('builds')).toEqual([current, previous]);
            expect(await host.listRemote('runtimes')).toEqual([runtimes.keep, runtimes.previous]);
        });

        it('skips while an install holds the lock', async () => {
            await makeBuild(current, runtimes.keep, 0);
            await makeBuild(older, runtimes.orphan, 200);
            await makeBuild(previous, runtimes.previous, 100);
            await mkdir(join(host.serverRoot(), 'install.lock'));
            await writeFile(join(host.serverRoot(), 'install.lock', 'pid'), `${process.pid}\n`);
            const collected = await host.run(
                gcScript({ buildId: current, runtimeSha256: runtimes.keep }),
            );
            expect(collected.result?.get('status')).toBe('locked');
            expect(await host.listRemote('builds')).toHaveLength(3);
            await stat(host.remotePath('install.lock'));
        });
    });
});
