import type { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';

import type { ServerClient } from '@caxri/client/supervise';
import { connectDesktopWithCredential } from '@caxri/client/supervise';
import { computeBuildFingerprint } from '@caxri/system';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AskpassBridge } from '../askpass';
import { parseSshDestination } from '../destination';
import type { RemoteArchitecture, RemoteLayerDescriptor } from '../remote-layers';
import { readRemoteLayer } from '../remote-layers';
import { parseRemoteResult } from '../remote-scripts';
import type { RemoteStateUpdate } from '../remote-server-supervisor';
import { RemoteServerSupervisor } from '../remote-server-supervisor';
import type { SshConnectionOptions } from '../ssh-connection';
import { SshConnection, SshConnectionError } from '../ssh-connection';
import { makeShortTemporaryDirectory } from './support/remote-fixtures';

const execFileAsync = promisify(execFile);

/**
 * End-to-end attach against a real SSH Host. Opt-in because it needs a disposable host:
 *
 *     CAXRI_SSH_INTEGRATION=1 CAXRI_SSH_CONFIG=/tmp/caxri-ssh-lab/ssh_config bunx vitest run <this file>
 *
 * `CAXRI_SSH_DESTINATION` defaults to `caxri-lab`. The test stops any remote Server it finds and deletes
 * `~/.caxri-server` (and its scratch Project folder) on that host before and after running, so never point it at a host
 * you use. The application layers come from `apps/server/dist/remote` (build them first with `bun run
 * apps/server/scripts/build-remote-layers.ts`).
 *
 * `CAXRI_SSH_INTEGRATION_RUNTIME_SOURCE` asserts how the cold install obtained Node: `remote-download` when the host
 * reaches nodejs.org, `local-upload` when its egress is blocked. `CAXRI_SSH_INTEGRATION_REPORT=<file>` writes timings.
 */
const isEnabled = process.env.CAXRI_SSH_INTEGRATION === '1';
const configFile = process.env.CAXRI_SSH_CONFIG;
const destination = process.env.CAXRI_SSH_DESTINATION ?? 'caxri-lab';
const expectedRuntimeSource = process.env.CAXRI_SSH_INTEGRATION_RUNTIME_SOURCE;
const layersRoot = resolve(import.meta.dirname, '../../../../../server/dist/remote');
const localBundles = resolve(import.meta.dirname, '../../../../../server/dist/bundles');
const PROJECT_FOLDER = 'caxri-integration-project';

const RESET_SCRIPT = String.raw`pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$HOME/.caxri-server/profile/host/manifest.json" 2>/dev/null | head -n 1)
if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    i=0
    while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 50 ]; do sleep 0.2; i=$((i + 1)); done
fi
rm -rf "$HOME/.caxri-server" "$HOME/${PROJECT_FOLDER}"
`;

/**
 * Lists installed builds and runtimes, and the build the given pid runs from, as a marker-delimited result.
 */
function inventoryScript(marker: string, pid: number): string {
    return String.raw`set -eu
printf '%s\n' '__CAXRI_${marker}_BEGIN__'
printf 'builds=%s\n' "$(ls -1 "$HOME/.caxri-server/builds" 2>/dev/null | grep -v '^\.' | sort | tr '\n' ',')"
printf 'runtimes=%s\n' "$(ls -1 "$HOME/.caxri-server/runtimes" 2>/dev/null | grep -v '^\.' | sort | tr '\n' ',')"
if kill -0 ${pid} 2>/dev/null; then printf 'alive=1\n'; else printf 'alive=0\n'; fi
printf 'pidBuild=%s\n' "$(tr '\000' '\n' < /proc/${pid}/cmdline 2>/dev/null | sed -n 's|.*/\.caxri-server/builds/\([^/]*\)/.*|\1|p' | head -n 1)"
printf '%s\n' '__CAXRI_${marker}_END__'
`;
}

interface Inventory {
    alive: boolean;
    builds: string[];
    pidBuild: string;
    runtimes: string[];
}

interface Harness {
    /**
     * Bytes written to remote stdin (uploads) through every transport of this supervisor.
     */
    stdinBytes: () => number;
    states: RemoteStateUpdate[];
    supervisor: RemoteServerSupervisor;
    transports: SshConnection[];
}

function compareText(left: string, right: string): number {
    return left.localeCompare(right);
}

function splitList(value: string | undefined): string[] {
    return (value ?? '').split(',').filter((entry) => entry !== '');
}

async function waitFor(isDone: () => boolean, timeoutMs: number, label: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!isDone()) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
        // eslint-disable-next-line no-await-in-loop -- bounded polling
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

describe.skipIf(!isEnabled)('remote SSH Host (integration)', () => {
    let root: string;
    let control: SshConnection | undefined;
    let architecture: RemoteArchitecture;
    let baseDescriptor: RemoteLayerDescriptor;
    let firstPid = 0;
    const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const report: Record<string, unknown> = {};
    const openClients: ServerClient[] = [];
    const harnesses: Harness[] = [];

    async function inventory(pid: number): Promise<Inventory> {
        const marker = createHash('sha256')
            .update(String(Math.random()))
            .digest('hex')
            .slice(0, 16);
        const { stdout } = await control!.exec(inventoryScript(marker, pid), { timeoutMs: 30_000 });
        const result = parseRemoteResult(stdout, marker);
        return {
            alive: result?.get('alive') === '1',
            builds: splitList(result?.get('builds')),
            pidBuild: result?.get('pidBuild') ?? '',
            runtimes: splitList(result?.get('runtimes')),
        };
    }

    function createHarness(layers = layersRoot): Harness {
        const states: RemoteStateUpdate[] = [];
        const transports: SshConnection[] = [];
        let stdinBytes = 0;
        const supervisor = new RemoteServerSupervisor({
            askpass: () => Promise.resolve(null),
            ...(configFile !== undefined && { configFile }),
            destination,
            electronExecutable: process.execPath,
            logger: {
                write: (_level, event, options) => {
                    events.push({
                        event,
                        fields: options?.fields,
                    });
                },
            },
            onState: (update) => states.push(update),
            privateDirectory: join(root, 'ctl'),
            remoteLayersRoot: layers,
            runtimeCacheDirectory: join(root, 'runtimes'),
            createTransport: (options: SshConnectionOptions) => {
                const connection = new SshConnection(options);
                transports.push(connection);
                const exec = connection.exec.bind(connection);
                // Counts the bytes that actually travel to the host so "no re-upload" is measured, not inferred.
                connection.exec = (script, execOptions) => {
                    if (!execOptions.stdin) return exec(script, execOptions);
                    const counter = new PassThrough();
                    counter.on('data', (chunk: Buffer) => {
                        stdinBytes += chunk.length;
                    });
                    execOptions.stdin.on('error', (error) => counter.destroy(error));
                    return exec(script, { ...execOptions, stdin: execOptions.stdin.pipe(counter) });
                };
                return connection;
            },
        });
        const harness = { states, stdinBytes: () => stdinBytes, supervisor, transports };
        harnesses.push(harness);
        return harness;
    }

    function eventsSince(index: number, name: string): Array<Record<string, unknown>> {
        return events
            .slice(index)
            .filter((entry) => entry.event === name)
            .map((entry) => entry.fields ?? {});
    }

    /**
     * Copies the base layer with one extra listed file, which yields a different `buildId` (as a new Desktop release
     * would) while the bundles, and so the Server's reported fingerprint, stay the same.
     */
    async function deriveLayer(name: string): Promise<{ buildId: string; root: string }> {
        const work = join(root, `layer-${name}`);
        const tree = join(work, 'tree');
        const layerDirectory = join(work, 'layers', `linux-${architecture}`);
        await mkdir(tree, { recursive: true });
        await mkdir(layerDirectory, { recursive: true });
        await execFileAsync('tar', [
            '-xzf',
            join(layersRoot, `linux-${architecture}`, 'app.tar.gz'),
            '-C',
            tree,
        ]);
        const marker = `integration layer ${name}\n`;
        await writeFile(join(tree, 'integration-marker.txt'), marker);
        const sums = await readFile(join(tree, 'SHA256SUMS'), 'utf8');
        const markerSha = createHash('sha256').update(marker).digest('hex');
        await writeFile(join(tree, 'SHA256SUMS'), `${sums}${markerSha}  integration-marker.txt\n`);
        const archive = join(layerDirectory, 'app.tar.gz');
        // COPYFILE_DISABLE keeps macOS tar from adding AppleDouble `._*` members the checksum list would not cover.
        await execFileAsync('tar', ['-czf', archive, '-C', tree, '.'], {
            env: { ...process.env, COPYFILE_DISABLE: '1' },
        });
        const archiveSha = createHash('sha256')
            .update(await readFile(archive))
            .digest('hex');
        const buildId = archiveSha.slice(0, 16);
        const descriptor: RemoteLayerDescriptor = {
            ...baseDescriptor,
            buildId,
            app: { ...baseDescriptor.app, sha256: archiveSha, bytes: (await stat(archive)).size },
        };
        await writeFile(join(layerDirectory, 'descriptor.json'), JSON.stringify(descriptor));
        return { buildId, root: join(work, 'layers') };
    }

    beforeAll(async () => {
        const descriptors = await Promise.allSettled(
            ['linux-arm64', 'linux-x64'].map((target) =>
                access(join(layersRoot, target, 'descriptor.json')),
            ),
        );
        if (descriptors.every((outcome) => outcome.status === 'rejected'))
            throw new Error(`No remote Server layers in ${layersRoot}; build apps/server first`);
        root = await makeShortTemporaryDirectory('int');
        control = new SshConnection({
            ...(configFile !== undefined && { configFile }),
            controlDirectory: join(root, 'reset'),
            destination: parseSshDestination(destination),
        });
        await control.start();
        await control.exec(RESET_SCRIPT, { timeoutMs: 30_000 });
    }, 60_000);

    afterAll(async () => {
        for (const client of openClients) client.close();
        await Promise.all(harnesses.map((harness) => harness.supervisor.dispose()));
        if (control?.isOpen) await control.exec(RESET_SCRIPT, { timeoutMs: 30_000 });
        await control?.stop();
        if (root) await rm(root, { force: true, recursive: true });
        const reportFile = process.env.CAXRI_SSH_INTEGRATION_REPORT;
        if (reportFile) await writeFile(reportFile, JSON.stringify({ ...report, events }, null, 2));
    }, 60_000);

    let first: Harness;

    it(
        'installs on a clean host and reports the local bundle fingerprint',
        async () => {
            first = createHarness();
            const eventIndex = events.length;
            const startedAt = Date.now();
            const client = await first.supervisor.ensure(30_000);
            report.coldMs = Date.now() - startedAt;
            openClients.push(client);
            const status = await client.request('host.status');
            const { manifest } = await first.supervisor.discoverDesktop();
            expect(status.pid).toBe(manifest.pid);
            firstPid = status.pid;
            const probedArchitecture = first.states.findLast((state) => state.platform)?.platform
                ?.architecture;
            expect(probedArchitecture).toBeDefined();
            architecture = probedArchitecture ?? 'arm64';
            const layer = await readRemoteLayer(layersRoot, architecture);
            baseDescriptor = layer.descriptor;
            expect(status.buildId).toBe(layer.descriptor.fingerprint);
            expect(status.buildId).toBe(await computeBuildFingerprint(localBundles));
            expect(first.states.map((state) => state.phase)).toContain('installing');
            expect(first.states.at(-1)?.phase).toBe('connected');
            const installed = eventsSince(eventIndex, 'remote_ssh.installed').at(0);
            expect(installed).toBeDefined();
            if (expectedRuntimeSource) expect(installed?.runtimeSource).toBe(expectedRuntimeSource);
            report.cold = {
                architecture,
                installed,
                stdinBytes: first.stdinBytes(),
                launched: eventsSince(eventIndex, 'remote_ssh.launched'),
            };
            const remote = await inventory(firstPid);
            expect(remote.builds).toEqual([layer.descriptor.buildId]);
            expect(remote.runtimes).toEqual([layer.descriptor.runtime.sha256]);
            expect(remote.pidBuild).toBe(layer.descriptor.buildId);
        },
        10 * 60_000,
    );

    it('adopts the running Server from a second window without uploading', async () => {
        const second = createHarness();
        const startedAt = Date.now();
        const client = await second.supervisor.ensure(30_000);
        report.warmMs = Date.now() - startedAt;
        openClients.push(client);
        expect((await second.supervisor.discoverDesktop()).manifest.pid).toBe(firstPid);
        expect(second.states.map((state) => state.phase)).not.toContain('installing');
        expect(second.stdinBytes()).toBe(0);
        client.close();
        await second.supervisor.dispose();
        expect(first.transports.at(-1)?.isOpen).toBe(true);
    }, 60_000);

    it('surfaces a lost master and reconnects to the same Server', async () => {
        const transport = first.transports.at(-1);
        expect(transport?.isOpen).toBe(true);
        const operator = openClients.at(0);
        let isOperatorClosed = false;
        operator?.onClose(() => {
            isOperatorClosed = true;
        });
        const stateIndex = first.states.length;
        await execFileAsync('ssh', [
            ...(configFile === undefined ? [] : ['-F', configFile]),
            '-o',
            `ControlPath=${transport?.controlPath ?? ''}`,
            '-O',
            'exit',
            destination,
        ]);
        await waitFor(
            () => first.states.slice(stateIndex).some((state) => state.phase === 'reconnecting'),
            10_000,
            'reconnecting state',
        );
        const lost = first.states.slice(stateIndex).find((state) => state.phase === 'reconnecting');
        expect(lost?.failure?.reason).toBe('connectionLost');
        await waitFor(() => isOperatorClosed, 10_000, 'operator socket close');
        const startedAt = Date.now();
        const client = await first.supervisor.ensure(30_000);
        report.reconnectMs = Date.now() - startedAt;
        openClients.push(client);
        const status = await client.request('host.status');
        expect(status.pid).toBe(firstPid);
        expect(first.transports).toHaveLength(2);
        expect(first.states.at(-1)?.phase).toBe('connected');
    }, 60_000);

    it('serves a Desktop connection: Project, Session, and a Terminal echo', async () => {
        await control!.exec(`mkdir -p "$HOME/${PROJECT_FOLDER}"`, { timeoutMs: 10_000 });
        const { credential, manifest } = await first.supervisor.discoverDesktop();
        const desktopCommands: string[] = [];
        const desktop = await connectDesktopWithCredential(
            manifest,
            credential,
            'integration-desktop',
            (operation) => {
                desktopCommands.push(JSON.stringify(operation).slice(0, 200));
                return Promise.resolve(null);
            },
            15_000,
        );
        openClients.push(desktop);
        const startedAt = Date.now();
        const browsed = await desktop.request('project.browseFolders', {});
        const projectEntry = browsed.entries.find((entry) => entry.name === PROJECT_FOLDER);
        expect(projectEntry).toBeDefined();
        const project = await desktop.requestServerOperation('project.create', {
            rootPath: projectEntry?.path ?? '',
        });
        expect(project.rootPath).toBe(projectEntry?.path);
        const created = await desktop.request('session.create', {
            projectId: project.id,
            defaultAgent: null,
        });
        const terminal = await desktop.request('terminal.create', {
            sessionId: created.session.id,
            kind: 'shell',
        });
        let output = '';
        desktop.onEvent((event) => {
            if (event.event === 'terminal.output' && event.payload.terminalId === terminal.id)
                output += event.payload.data;
        });
        await desktop.request('terminal.attach', { terminalId: terminal.id, cols: 80, rows: 24 });
        await desktop.request('terminal.input', {
            terminalId: terminal.id,
            data: 'echo "caxri-$((40 + 2))"\r',
        });
        await waitFor(() => output.includes('caxri-42'), 15_000, 'Terminal echo');
        report.desktopFlowMs = Date.now() - startedAt;
        report.desktopCommands = desktopCommands;
        await desktop.request('terminal.close', { terminalId: terminal.id });
    }, 60_000);

    it('stops the Server with host.stop and waits for its exit', async () => {
        const operator = await first.supervisor.ensure(30_000);
        const startedAt = Date.now();
        await operator.request('host.stop', { confirmLivePtys: true });
        operator.close();
        first.supervisor.releaseProcess(firstPid);
        await first.supervisor.waitForExit(firstPid, 15_000);
        report.stopMs = Date.now() - startedAt;
        expect((await inventory(firstPid)).alive).toBe(false);
    }, 60_000);

    it(
        'installs only the app layer for a new build and keeps current plus previous',
        async () => {
            const second = await deriveLayer('b');
            const updater = createHarness(second.root);
            let eventIndex = events.length;
            let startedAt = Date.now();
            const client = await updater.supervisor.ensure(30_000);
            report.updateMs = Date.now() - startedAt;
            const status = await client.request('host.status');
            expect(status.pid).not.toBe(firstPid);
            const installed = eventsSince(eventIndex, 'remote_ssh.installed').at(0);
            expect(installed?.runtimeSource).toBe('cached');
            // Only the application layer travels; the 120 MB runtime stays cached on the host.
            expect(updater.stdinBytes()).toBe(
                (await readRemoteLayer(second.root, architecture)).descriptor.app.bytes,
            );
            report.update = { installed, stdinBytes: updater.stdinBytes() };
            let remote = await inventory(status.pid);
            expect(remote.pidBuild).toBe(second.buildId);
            expect(remote.builds.toSorted(compareText)).toEqual(
                [baseDescriptor.buildId, second.buildId].toSorted(compareText),
            );

            await client.request('host.stop', { confirmLivePtys: true });
            client.close();
            updater.supervisor.releaseProcess(status.pid);
            await updater.supervisor.waitForExit(status.pid, 15_000);
            await updater.supervisor.dispose();

            const third = await deriveLayer('c');
            const next = createHarness(third.root);
            eventIndex = events.length;
            startedAt = Date.now();
            const thirdClient = await next.supervisor.ensure(30_000);
            report.secondUpdateMs = Date.now() - startedAt;
            const thirdStatus = await thirdClient.request('host.status');
            expect(eventsSince(eventIndex, 'remote_ssh.installed')[0]?.runtimeSource).toBe(
                'cached',
            );
            remote = await inventory(thirdStatus.pid);
            expect(remote.pidBuild).toBe(third.buildId);
            // GC kept the current and the most recent previous build and removed the original one.
            expect(remote.builds.toSorted(compareText)).toEqual(
                [second.buildId, third.buildId].toSorted(compareText),
            );
            expect(remote.runtimes).toEqual([baseDescriptor.runtime.sha256]);
            thirdClient.close();
            await next.supervisor.dispose();
        },
        5 * 60_000,
    );

    it(
        'keeps the Server running after every window detaches',
        async () => {
            await first.supervisor.dispose();
            const later = createHarness();
            const before = await inventory(0);
            const client = await later.supervisor.ensure(30_000);
            const status = await client.request('host.status');
            // The original build is gone after GC, so the original layer is installed again (runtime cached) and the
            // running Server from build "c" is adopted rather than replaced.
            expect(before.builds).not.toContain(baseDescriptor.buildId);
            expect((await inventory(status.pid)).alive).toBe(true);
            expect(later.states.at(-1)?.phase).toBe('connected');
            client.close();
            await later.supervisor.dispose();
        },
        2 * 60_000,
    );
});

/**
 * Real OpenSSH prompts through the askpass bridge. The lab's identity is copied and re-encrypted with a passphrase, and
 * a fresh `known_hosts` with `StrictHostKeyChecking ask` makes OpenSSH ask about the host key first. The user's own SSH
 * files are never read: everything is derived from `ssh -G` against `CAXRI_SSH_CONFIG`.
 */
describe.skipIf(!isEnabled)('remote SSH askpass (integration)', () => {
    const PASSPHRASE = 'integration passphrase';
    let root: string;
    let host: { hostName: string; identityFile: string; port: string; user: string };

    beforeAll(async () => {
        root = await makeShortTemporaryDirectory('askpass');
        const { stdout } = await execFileAsync('ssh', [
            ...(configFile === undefined ? [] : ['-F', configFile]),
            '-G',
            destination,
        ]);
        const options = new Map<string, string>();
        for (const line of stdout.split('\n')) {
            const separator = line.indexOf(' ');
            if (separator > 0 && !options.has(line.slice(0, separator)))
                options.set(line.slice(0, separator), line.slice(separator + 1));
        }
        host = {
            hostName: options.get('hostname') ?? '',
            identityFile: options.get('identityfile') ?? '',
            port: options.get('port') ?? '22',
            user: options.get('user') ?? '',
        };
        const key = join(root, 'key');
        await writeFile(key, await readFile(host.identityFile), { mode: 0o600 });
        await execFileAsync('ssh-keygen', ['-q', '-p', '-P', '', '-N', PASSPHRASE, '-f', key]);
    }, 60_000);

    afterAll(async () => {
        if (root) await rm(root, { force: true, recursive: true });
    });

    async function writeConfig(name: string): Promise<string> {
        const path = join(root, `${name}.config`);
        await writeFile(
            path,
            [
                'Host askpass-lab',
                `  HostName ${host.hostName}`,
                `  Port ${host.port}`,
                `  User ${host.user}`,
                `  IdentityFile ${join(root, 'key')}`,
                '  IdentitiesOnly yes',
                '  PreferredAuthentications publickey',
                '  StrictHostKeyChecking ask',
                `  UserKnownHostsFile ${join(root, `${name}.known_hosts`)}`,
                '',
            ].join('\n'),
        );
        return path;
    }

    async function connect(
        config: string,
        answer: (kind: string) => string | null,
    ): Promise<{ error?: unknown; kinds: string[]; ms: number }> {
        const kinds: string[] = [];
        const bridge = await AskpassBridge.create({
            directory: join(root, 'ctl'),
            electronExecutable: process.execPath,
            handler: (request) => {
                kinds.push(request.kind);
                return Promise.resolve(answer(request.kind));
            },
        });
        const connection = new SshConnection({
            configFile: config,
            controlDirectory: join(root, 'ctl'),
            destination: parseSshDestination('askpass-lab'),
            environment: bridge.environment(),
        });
        const startedAt = Date.now();
        let error: unknown;
        try {
            await connection.start();
            const { stdout } = await connection.exec('echo connected', { timeoutMs: 10_000 });
            expect(stdout).toContain('connected');
        } catch (error_) {
            error = error_;
        }
        const ms = Date.now() - startedAt;
        await connection.stop();
        await bridge.close();
        return { ms, kinds, ...(error !== undefined && { error }) };
    }

    it('asks to confirm a new host key, then for the key passphrase', async () => {
        const config = await writeConfig('accept');
        const result = await connect(config, (kind) => (kind === 'confirm' ? 'yes' : PASSPHRASE));
        expect(result.error).toBeUndefined();
        expect(result.kinds).toEqual(['confirm', 'secret']);
        // The accepted key was recorded, so the next connection only asks for the passphrase.
        const again = await connect(config, () => PASSPHRASE);
        expect(again.error).toBeUndefined();
        expect(again.kinds).toEqual(['secret']);
    }, 60_000);

    it('classifies a wrong passphrase as authentication', async () => {
        const config = await writeConfig('wrong');
        const result = await connect(config, (kind) => (kind === 'confirm' ? 'yes' : 'wrong'));
        expect(result.error).toBeInstanceOf(SshConnectionError);
        expect((result.error as SshConnectionError).reason).toBe('authentication');
        expect(result.kinds[0]).toBe('confirm');
        expect(result.kinds.slice(1).every((kind) => kind === 'secret')).toBe(true);
    }, 60_000);

    it('classifies a refused host key as hostKey', async () => {
        const config = await writeConfig('refuse');
        const result = await connect(config, () => null);
        expect(result.error).toBeInstanceOf(SshConnectionError);
        expect((result.error as SshConnectionError).reason).toBe('hostKey');
        expect(result.kinds).toEqual(['confirm']);
    }, 60_000);
});
