import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    compareVersions,
    fetchRuntimeScript,
    installAppScript,
    launchScript,
    parseProbe,
    parseSshHostResult,
    probeScript,
    seedConfigScript,
    stopWaitScript,
} from '../scripts';
import { launchFailureDetail } from '../setup';
import type { LayerFixture } from './support/fixtures';
import { buildLayerFixture, runLocalScript, writeShims } from './support/fixtures';
import { SshHostScriptHost } from './support/script-host';

/**
 * Result parsing, input validation, and the probe, launch, stop-wait, and seed-config scripts. The install and cache
 * scripts are covered in `remote-scripts-install.test.ts`.
 */
describe('remote scripts', () => {
    let host: SshHostScriptHost;

    beforeEach(async () => {
        host = await SshHostScriptHost.create();
    });

    afterEach(async () => {
        await host.dispose();
    });

    describe('parseSshHostResult', () => {
        it('reads only the block between its own markers', () => {
            const stdout = [
                'Welcome to the host',
                '__CAXRI_other_BEGIN__',
                'status=spoofed',
                '__CAXRI_other_END__',
                '__CAXRI_abc_BEGIN__',
                'status=installed',
                'manifest=eyJhIjoxfQ==',
                'status=duplicate',
                'garbage',
                '__CAXRI_abc_END__',
                'bye',
            ].join('\n');
            expect(parseSshHostResult(stdout, 'abc')).toEqual(
                new Map([
                    ['status', 'installed'],
                    ['manifest', 'eyJhIjoxfQ=='],
                ]),
            );
            expect(parseSshHostResult('__CAXRI_abc_BEGIN__\nstatus=x\n', 'abc')).toBeUndefined();
            expect(parseSshHostResult('nothing', 'abc')).toBeUndefined();
        });
    });

    describe('compareVersions', () => {
        it('compares dotted numeric versions', () => {
            expect(compareVersions('2.28', '2.28')).toBe(0);
            expect(compareVersions('2.36', '2.28')).toBeGreaterThan(0);
            expect(compareVersions('2.9', '2.28')).toBeLessThan(0);
            expect(compareVersions('2.28.1', '2.28')).toBeGreaterThan(0);
        });
    });

    describe('script inputs', () => {
        it('refuses values that are not hashes or relative paths', () => {
            expect(() => probeScript({ buildIds: ["x'; rm -rf ~"], runtimeSha256s: [] })).toThrow();
            expect(() =>
                installAppScript({
                    appSha256: 'ab',
                    buildId: 'cd',
                    runtimePath: '../escape',
                    runtimeSha256: 'ef',
                }),
            ).toThrow();
            expect(() =>
                fetchRuntimeScript({
                    member: 'node',
                    runtimeSha256: 'ab',
                    sha256: 'cd',
                    url: 'file:///tmp/node.tar.gz',
                }),
            ).toThrow();
            expect(() => stopWaitScript({ pid: -1, timeoutSeconds: 1 })).toThrow();
        });
    });

    describe('probe', () => {
        it('reports platform, tools, installs, and the profile on an empty host', async () => {
            const { code, result } = await host.run(
                probeScript({ buildIds: ['0123'], runtimeSha256s: ['ab'] }),
            );
            expect(code).toBe(0);
            const probe = parseProbe(result ?? new Map<string, string>());
            expect(probe).toMatchObject({
                architecture: 'x64',
                configPresent: false,
                glibc: '2.36',
                home: host.home,
                hostname: 'test-host',
                os: 'Linux',
            });
            expect(probe.builds.size).toBe(0);
            expect(probe.runtimes.size).toBe(0);
            expect(probe.server).toBeUndefined();
            expect(probe.tools).toMatchObject({ base64: true, curl: true, gzip: true, tar: true });
        });

        it('detects a musl host through ldd and maps aarch64', async () => {
            await writeShims(host.shims, {
                getconf: 'exit 1',
                ldd: 'echo "musl libc (aarch64)"; echo "Version 1.2.4"',
                uname: 'case "$1" in -s) echo Linux ;; -m) echo aarch64 ;; *) echo alpine ;; esac',
            });
            const probe = parseProbe(
                (await host.run(probeScript({ buildIds: [], runtimeSha256s: [] }))).result ??
                    new Map<string, string>(),
            );
            expect(probe.architecture).toBe('arm64');
            expect(probe.glibc).toBe('');
        });

        it('reads glibc from ldd when getconf is missing', async () => {
            await writeShims(host.shims, {
                getconf: 'exit 1',
                ldd: 'echo "ldd (Debian GLIBC 2.28-10+deb10u2) 2.28"',
            });
            const probe = parseProbe(
                (await host.run(probeScript({ buildIds: [], runtimeSha256s: [] }))).result ??
                    new Map<string, string>(),
            );
            expect(probe.glibc).toBe('2.28');
        });

        it('survives a login shell that prints noise and reports installed layers and the server', async () => {
            const layers = join(host.root, 'layers');
            const fixture = await buildLayerFixture(layers);
            await host.installBuild(fixture, layers);
            await mkdir(join(host.serverRoot(), 'profile', 'config'), { recursive: true });
            const launched = await host.run(launchScript({ buildId: fixture.descriptor.buildId }));
            expect(launched.result?.get('outcome')).toBe('started');

            const script = probeScript({
                buildIds: [fixture.descriptor.buildId, 'ffffffffffffffff'],
                runtimeSha256s: [fixture.descriptor.runtime.sha256],
            });
            const output = await runLocalScript(
                `echo "Last login: today"\n${script.script}`,
                host.environment,
            );
            const probe = parseProbe(
                parseSshHostResult(output.stdout, script.marker) ?? new Map<string, string>(),
            );
            expect([...probe.builds]).toEqual([fixture.descriptor.buildId]);
            expect([...probe.runtimes]).toEqual([fixture.descriptor.runtime.sha256]);
            expect(probe.configPresent).toBe(true);
            expect(probe.server?.pid).toBe(Number(launched.result?.get('pid')));
        });
    });
    describe('launch', () => {
        let layers: string;
        let fixture: LayerFixture;

        beforeEach(() => {
            layers = join(host.root, 'layers');
        });

        it('reports a missing build', async () => {
            const launched = await host.run(launchScript({ buildId: '0123456789abcdef' }));
            expect(launched.code).toBe(30);
            expect(launched.result?.get('outcome')).toBe('missing-build');
        });

        it('starts a detached Server, then adopts it', async () => {
            fixture = await buildLayerFixture(layers);
            await host.installBuild(fixture, layers);
            const started = await host.run(
                launchScript({ buildId: fixture.descriptor.buildId, logLevel: 'debug' }),
            );
            expect(started.code).toBe(0);
            expect(started.result?.get('outcome')).toBe('started');
            const manifest = JSON.parse(
                Buffer.from(started.result?.get('manifest') ?? '', 'base64').toString('utf8'),
            ) as { pid: number; processIdentity: string };
            const credential = JSON.parse(
                Buffer.from(started.result?.get('credential') ?? '', 'base64').toString('utf8'),
            ) as { processIdentity: string };
            expect(manifest.pid).toBe(Number(started.result?.get('pid')));
            expect(credential.processIdentity).toBe(manifest.processIdentity);

            const launchEnvironment = await readFile(
                join(host.serverRoot(), 'profile', 'launch-environment.txt'),
                'utf8',
            );
            const build = join(host.serverRoot(), 'builds', fixture.descriptor.buildId);
            expect(launchEnvironment).toContain(
                `CAXRI_USER_DATA_PATH=${join(host.serverRoot(), 'profile')}`,
            );
            expect(launchEnvironment).toContain(
                `CAXRI_AGENT_HOOKS_PATH=${join(host.serverRoot(), 'agent-hooks')}`,
            );
            expect(launchEnvironment).toContain('CAXRI_INSPECT=0');
            expect(launchEnvironment).toContain('CAXRI_LOG_LEVEL=debug');
            expect(launchEnvironment).toContain(`CAXRI_CLI_PATH=${join(build, 'cli/caxri.cjs')}`);
            expect(launchEnvironment).not.toContain('SSH_CONNECTION');
            expect(launchEnvironment).not.toMatch(/^NODE_(?:OPTIONS|PATH)=/mu);
            expect((await stat(host.serverRoot())).mode & 0o777).toBe(0o700);

            const adopted = await host.run(launchScript({ buildId: fixture.descriptor.buildId }));
            expect(adopted.result?.get('outcome')).toBe('adopted');
            expect(adopted.result?.get('pid')).toBe(String(manifest.pid));
        });

        it('fails when the Server exits without discovery files', { timeout: 20_000 }, async () => {
            fixture = await buildLayerFixture(layers, {
                extraFiles: {
                    'runtime/caxri-server': '#!/bin/sh\necho "fatal: profile locked" >&2\nexit 1\n',
                },
            });
            await host.installBuild(fixture, layers);
            const launched = await host.run(launchScript({ buildId: fixture.descriptor.buildId }));
            expect(launched.code).toBe(31);
            expect(launched.result?.get('outcome')).toBe('exited');
            expect(launched.stderr).toContain('fatal: profile locked');
        });

        it(
            'keeps the error header of a Node crash for the failure detail',
            { timeout: 20_000 },
            async () => {
                const crash = [
                    'file:///remote/bundles/process.js:1',
                    'CaxriError: A Host already owns this profile',
                    ...Array.from(
                        { length: 8 },
                        (_, index) => `    at frame${index} (process.js:1:${index})`,
                    ),
                    "  code: 'CONFLICT'",
                    '}',
                    '',
                    'Node.js v24.0.0',
                ];
                fixture = await buildLayerFixture(layers, {
                    extraFiles: {
                        'runtime/caxri-server': `#!/bin/sh\ncat >&2 <<'CRASH'\n${crash.join('\n')}\nCRASH\nexit 1\n`,
                    },
                });
                await host.installBuild(fixture, layers);
                const launched = await host.run(
                    launchScript({ buildId: fixture.descriptor.buildId }),
                );
                expect(launched.result?.get('outcome')).toBe('exited');
                expect(launchFailureDetail(launched.stderr)).toBe(
                    'CaxriError: A Host already owns this profile',
                );
                expect(launchFailureDetail('fatal: profile locked\n')).toBe(
                    'fatal: profile locked',
                );
            },
        );

        it(
            'never reports an earlier run crash as this launch failure',
            { timeout: 20_000 },
            async () => {
                fixture = await buildLayerFixture(layers, {
                    extraFiles: {
                        'runtime/caxri-server':
                            '#!/bin/sh\necho "fatal: port refused" >&2\nexit 1\n',
                    },
                });
                await host.installBuild(fixture, layers);
                const logs = join(host.serverRoot(), 'profile', 'logs');
                await mkdir(logs, { recursive: true });
                await writeFile(
                    join(logs, 'server-stdio.log'),
                    'CaxriError: A Host already owns this profile\n\nNode.js v24.0.0\n',
                );
                const launched = await host.run(
                    launchScript({ buildId: fixture.descriptor.buildId }),
                );
                expect(launchFailureDetail(launched.stderr)).toBe('fatal: port refused');
            },
        );

        it('reports the host holding a shared-home profile without waiting out the exit grace', async () => {
            fixture = await buildLayerFixture(layers, {
                extraFiles: {
                    'runtime/caxri-server':
                        '#!/bin/sh\necho "CAXRI_PROFILE_IN_USE host=login-1.cluster" >&2\nexit 1\n',
                },
            });
            await host.installBuild(fixture, layers);
            const startedAt = Date.now();
            const launched = await host.run(launchScript({ buildId: fixture.descriptor.buildId }));
            expect(launched.code).toBe(33);
            expect(launched.result?.get('outcome')).toBe('profile-in-use');
            expect(launched.result?.get('holder')).toBe('login-1.cluster');
            expect(Date.now() - startedAt).toBeLessThan(4000);
        });

        it(
            'ignores a profile-in-use line left in the log by an earlier start',
            { timeout: 20_000 },
            async () => {
                fixture = await buildLayerFixture(layers, {
                    extraFiles: { 'runtime/caxri-server': '#!/bin/sh\nexit 1\n' },
                });
                await host.installBuild(fixture, layers);
                const logs = join(host.serverRoot(), 'profile', 'logs');
                await mkdir(logs, { recursive: true });
                await writeFile(
                    join(logs, 'server-stdio.log'),
                    'CAXRI_PROFILE_IN_USE host=login-1.cluster\n',
                );
                const launched = await host.run(
                    launchScript({ buildId: fixture.descriptor.buildId }),
                );
                expect(launched.result?.get('outcome')).toBe('exited');
            },
        );

        it('times out when discovery files never appear', async () => {
            fixture = await buildLayerFixture(layers, {
                extraFiles: { 'runtime/caxri-server': '#!/bin/sh\nexec sleep 5\n' },
            });
            await host.installBuild(fixture, layers);
            const launched = await host.run(
                launchScript({ buildId: fixture.descriptor.buildId, readySeconds: 1 }),
            );
            expect(launched.code).toBe(32);
            expect(launched.result?.get('outcome')).toBe('timeout');
        });
    });

    describe('stop-wait', () => {
        it('returns once the pid exits and reports a survivor', async () => {
            const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
            const pid = sleeper.pid ?? 0;
            try {
                const alive = await host.run(stopWaitScript({ pid, timeoutSeconds: 1 }));
                expect(alive.result?.get('state')).toBe('alive');
                setTimeout(() => sleeper.kill('SIGKILL'), 300);
                const exited = await host.run(stopWaitScript({ pid, timeoutSeconds: 10 }));
                expect(exited.result?.get('state')).toBe('exited');
            } finally {
                sleeper.kill('SIGKILL');
            }
        });
    });

    describe('seed-config', () => {
        it('writes a missing file and never overwrites an existing one', async () => {
            const target = join(host.serverRoot(), 'profile', 'config', 'settings.jsonc');
            const first = await host.run(
                seedConfigScript({ file: 'settings.jsonc' }),
                Buffer.from('{"a":1}'),
            );
            expect(first.result?.get('status')).toBe('written');
            const second = await host.run(
                seedConfigScript({ file: 'settings.jsonc' }),
                Buffer.from('{"a":2}'),
            );
            expect(second.result?.get('status')).toBe('present');
            expect(await readFile(target, 'utf8')).toBe('{"a":1}');
            expect(await host.listRemote('profile', 'config')).toEqual(['settings.jsonc']);
            expect(() => seedConfigScript({ file: '../x' as 'theme.json' })).toThrow();
        });
    });
});
