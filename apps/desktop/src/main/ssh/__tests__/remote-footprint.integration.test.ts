import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';

import type { ServerClient } from '@caxri/client/supervise';
import { connectDesktopWithCredential } from '@caxri/client/supervise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseSshDestination } from '../destination';
import { readRemoteLayer } from '../remote-layers';
import { RemoteServerSupervisor } from '../remote-server-supervisor';
import type { RemoteStateUpdate } from '../remote-server-supervisor-options';
import { SshConnection } from '../ssh-connection';
import { makeShortTemporaryDirectory } from './support/remote-fixtures';
import {
    createCountingConnection,
    isSshIntegrationEnabled,
    labConfigFile,
    labDestination,
    resetRemoteServerScript,
} from './support/ssh-lab';

/**
 * The SSH Host footprint benchmark: installs the Server on a clean lab host, then measures what it costs the host at
 * two stages and writes a receipt that `scripts/server-footprint.ts` compares with the checked-in baseline. Run it
 * through that script (`bun run benchmark:server-footprint`), which builds the remote layers, starts a disposable lab,
 * and gates the result; see `docs/server-footprint.md`.
 *
 * Opt-in twice: the lab variables of the SSH integration suites, plus `CAXRI_SERVER_FOOTPRINT_RECEIPT=<file>`, so a
 * plain run of the integration directory never resets the lab host twice in parallel.
 *
 * - `attached`: a Desktop is connected and nothing is open (Server Core, Terminal Host, Extension Host).
 * - `working`: one Git Project of 2,000 tracked files and a gitignored `node_modules` is open in a selected Session, with
 *   a shell Terminal, a file listing, and a Git summary.
 *
 * Memory is `Rss` and `Pss` from `/proc/<pid>/smaps_rollup`, the median of several samples after a settle delay. PSS
 * splits the shared Node binary pages between the processes, so the PSS total is what the host actually spends. Disk is
 * one `du` over `~/.caxri-server`, so the runtime hardlinked into each build counts once.
 */
const receiptFile = process.env.CAXRI_SERVER_FOOTPRINT_RECEIPT;
const layersRoot = resolve(import.meta.dirname, '../../../../../server/dist/remote');
const PROJECT_FOLDER = 'caxri-footprint-project';
const RESET_SCRIPT = resetRemoteServerScript(PROJECT_FOLDER);
const SERVER_ROLES = ['server-core', 'terminal-host', 'extension-host'] as const;
const SETTLE_MS = 10_000;
const SAMPLE_COUNT = 5;
const SAMPLE_INTERVAL_MS = 2000;

type ServerRole = (typeof SERVER_ROLES)[number];

interface ProcessSample {
    pid: number;
    pssKiB: number;
    role: ServerRole;
    rssKiB: number;
}

/**
 * Lists every process running a Server bundle from an installed build with its `Rss` and `Pss` in KiB.
 */
const SAMPLE_SCRIPT = String.raw`for dir in /proc/[0-9]*; do
    cmd=$(tr '\000' ' ' < "$dir/cmdline" 2>/dev/null) || continue
    case "$cmd" in */.caxri-server/builds/*) ;; *) continue ;; esac
    role=$(printf '%s\n' "$cmd" | sed -n 's|.*/bundles/\([a-z-]*\)\.js.*|\1|p')
    [ -n "$role" ] || continue
    awk -v role="$role" -v pid="$(basename "$dir")" '/^Rss:/ { rss = $2 } /^Pss:/ { pss = $2 } END { if (rss != "") printf "process %s %s %s %s\n", role, pid, rss, pss }' "$dir/smaps_rollup" 2>/dev/null
done
`;

/**
 * One `du` per line: within a single invocation a hardlinked runtime counts only under the first directory listed, so
 * the total needs its own pass.
 */
const DISK_SCRIPT = `cd "$HOME/.caxri-server"
du -sk runtimes builds profile
du -sk .
`;

/**
 * A deterministic Git Project: 200 directories of 10 tracked files, a gitignored `node_modules` of 50 packages, five
 * modified files, and one untracked file, so the file watcher, Git status, and the file tree all have real work.
 */
const FIXTURE_SCRIPT = String.raw`set -eu
root="$HOME/${PROJECT_FOLDER}"
rm -rf "$root"
mkdir -p "$root"
cd "$root"
git init -q -b main
i=0
while [ "$i" -lt 200 ]; do
    mkdir -p "src/module-$i"
    j=0
    while [ "$j" -lt 10 ]; do
        printf 'export const value%d = %d;\n' "$j" "$((i * 10 + j))" > "src/module-$i/file-$j.ts"
        j=$((j + 1))
    done
    i=$((i + 1))
done
i=0
while [ "$i" -lt 50 ]; do
    mkdir -p "node_modules/package-$i/lib"
    printf '{"name":"package-%d"}\n' "$i" > "node_modules/package-$i/package.json"
    printf 'module.exports = %d;\n' "$i" > "node_modules/package-$i/lib/index.js"
    i=$((i + 1))
done
printf 'node_modules/\n' > .gitignore
git add -A
git -c user.name=Caxri -c user.email=footprint@example.invalid commit -q -m fixture
for i in 0 1 2 3 4; do printf '// changed\n' >> "src/module-$i/file-0.ts"; done
printf 'export const draft = true;\n' > src/untracked.ts
`;

function median(values: number[]): number {
    const sorted = values.toSorted((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function toKiB(bytes: number): number {
    return Math.ceil(bytes / 1024);
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseProcessSamples(stdout: string): ProcessSample[] {
    const samples: ProcessSample[] = [];
    for (const line of stdout.split('\n')) {
        const match = /^process (\S+) (\d+) (\d+) (\d+)$/.exec(line.trim());
        const role = match?.[1] as ServerRole | undefined;
        if (!match || !role || !SERVER_ROLES.includes(role)) continue;
        samples.push({
            role,
            pid: Number(match[2]),
            rssKiB: Number(match[3]),
            pssKiB: Number(match[4]),
        });
    }
    return samples;
}

describe.skipIf(!isSshIntegrationEnabled || !receiptFile)('Server footprint on an SSH Host', () => {
    let root: string;
    let control: SshConnection | undefined;
    let supervisor: RemoteServerSupervisor | undefined;
    const openClients: ServerClient[] = [];

    async function remote(script: string, timeoutMs = 30_000): Promise<string> {
        return (await control!.exec(script, { timeoutMs })).stdout;
    }

    async function waitForRoles(roles: readonly ServerRole[]): Promise<void> {
        const deadline = Date.now() + 30_000;
        for (;;) {
            // eslint-disable-next-line no-await-in-loop -- bounded polling of remote processes
            const samples = parseProcessSamples(await remote(SAMPLE_SCRIPT));
            const running = new Set(samples.map((sample) => sample.role));
            if (roles.every((role) => running.has(role))) return;
            if (Date.now() > deadline) throw new Error(`Timed out waiting for ${roles.join(', ')}`);
            // eslint-disable-next-line no-await-in-loop -- bounded polling of remote processes
            await delay(500);
        }
    }

    /**
     * Settles, then records the median `Rss`/`Pss` per role and the totals under `memory.<stage>.`.
     */
    async function measureStage(stage: string, metrics: Record<string, number>): Promise<void> {
        await delay(SETTLE_MS);
        const rounds: ProcessSample[][] = [];
        for (let round = 0; round < SAMPLE_COUNT; round += 1) {
            // eslint-disable-next-line no-await-in-loop -- samples are spaced in time on purpose
            if (round > 0) await delay(SAMPLE_INTERVAL_MS);
            // eslint-disable-next-line no-await-in-loop -- samples are spaced in time on purpose
            rounds.push(parseProcessSamples(await remote(SAMPLE_SCRIPT)));
        }
        let totalRss = 0;
        let totalPss = 0;
        for (const role of SERVER_ROLES) {
            const samples = rounds.flatMap((round) =>
                round.filter((sample) => sample.role === role),
            );
            if (samples.length === 0) continue;
            const rss = median(samples.map((sample) => sample.rssKiB));
            const pss = median(samples.map((sample) => sample.pssKiB));
            metrics[`memory.${stage}.${role}.rssKiB`] = rss;
            metrics[`memory.${stage}.${role}.pssKiB`] = pss;
            totalRss += rss;
            totalPss += pss;
        }
        metrics[`memory.${stage}.totalRssKiB`] = totalRss;
        metrics[`memory.${stage}.totalPssKiB`] = totalPss;
    }

    beforeAll(async () => {
        try {
            await access(layersRoot);
        } catch {
            throw new Error(
                `No remote Server layers in ${layersRoot}; run scripts/server-footprint.ts`,
            );
        }
        root = await makeShortTemporaryDirectory('fp');
        control = new SshConnection({
            ...(labConfigFile !== undefined && { configFile: labConfigFile }),
            controlDirectory: join(root, 'reset'),
            destination: parseSshDestination(labDestination),
        });
        await control.start();
        await remote(RESET_SCRIPT);
    }, 60_000);

    afterAll(async () => {
        for (const client of openClients) client.close();
        await supervisor?.dispose();
        if (control?.isOpen) await remote(RESET_SCRIPT);
        await control?.stop();
        if (root) await rm(root, { force: true, recursive: true });
    }, 60_000);

    it(
        'measures install size, transfer, and per-process memory',
        async () => {
            const states: RemoteStateUpdate[] = [];
            const installed: Array<Record<string, unknown>> = [];
            let uploadBytes = 0;
            supervisor = new RemoteServerSupervisor({
                askpass: () => Promise.resolve(null),
                ...(labConfigFile !== undefined && { configFile: labConfigFile }),
                destination: labDestination,
                electronExecutable: process.execPath,
                logger: {
                    write: (_level, event, options) => {
                        if (event === 'remote_ssh.installed') installed.push(options?.fields ?? {});
                    },
                },
                onState: (update) => states.push(update),
                privateDirectory: join(root, 'ctl'),
                remoteLayersRoot: layersRoot,
                runtimeCacheDirectory: join(root, 'runtimes'),
                createTransport: (options) =>
                    createCountingConnection(options, (count) => {
                        uploadBytes += count;
                    }),
            });
            const metrics: Record<string, number> = {};
            const timings: Record<string, number> = {};

            let startedAt = Date.now();
            openClients.push(await supervisor.ensure(30_000));
            timings.coldInstallMs = Date.now() - startedAt;
            const architecture = states.findLast((state) => state.platform)?.platform?.architecture;
            expect(architecture).toBeDefined();
            const { descriptor } = await readRemoteLayer(layersRoot, architecture ?? 'arm64');
            metrics['transfer.appLayerKiB'] = toKiB(descriptor.app.bytes);
            metrics['transfer.uploadKiB'] = toKiB(uploadBytes);

            const { credential, manifest } = await supervisor.discoverDesktop();
            const desktop = await connectDesktopWithCredential(
                manifest,
                credential,
                'footprint-desktop',
                () => Promise.resolve(null),
                15_000,
            );
            openClients.push(desktop);
            await waitForRoles(['server-core', 'extension-host']);
            await measureStage('attached', metrics);

            await remote(FIXTURE_SCRIPT, 120_000);
            startedAt = Date.now();
            const browsed = await desktop.request('project.browseFolders', {});
            const entry = browsed.entries.find((candidate) => candidate.name === PROJECT_FOLDER);
            expect(entry).toBeDefined();
            const project = await desktop.requestServerOperation('project.create', {
                rootPath: entry?.path ?? '',
            });
            const { session } = await desktop.request('session.create', {
                projectId: project.id,
                defaultAgent: null,
            });
            await desktop.request('session.select', { sessionId: session.id });
            const terminal = await desktop.request('terminal.create', {
                sessionId: session.id,
                kind: 'shell',
            });
            let output = '';
            desktop.onEvent((event) => {
                if (event.event === 'terminal.output' && event.payload.terminalId === terminal.id)
                    output += event.payload.data;
            });
            await desktop.request('terminal.attach', {
                terminalId: terminal.id,
                cols: 120,
                rows: 32,
            });
            await desktop.request('terminal.input', {
                terminalId: terminal.id,
                data: 'echo "caxri-$((40 + 2))"\r',
            });
            const listing = await desktop.request('files.list', { sessionId: session.id });
            const source = listing.entries.find((candidate) => candidate.name === 'src');
            expect(source).toBeDefined();
            await desktop.request('files.list', { sessionId: session.id, directory: source?.path });
            const git = await desktop.request('git.summary', { sessionId: session.id });
            expect(git).toBeDefined();
            const deadline = Date.now() + 15_000;
            while (!output.includes('caxri-42')) {
                if (Date.now() > deadline) throw new Error('Timed out waiting for Terminal echo');
                // eslint-disable-next-line no-await-in-loop -- bounded polling
                await delay(50);
            }
            timings.workingFlowMs = Date.now() - startedAt;
            await waitForRoles(SERVER_ROLES);
            await measureStage('working', metrics);

            const diskUsage = await remote(DISK_SCRIPT);
            for (const line of diskUsage.split('\n')) {
                const match = /^(\d+)\s+(\S+)$/.exec(line.trim());
                if (!match) continue;
                const name = match[2] === '.' ? 'total' : match[2];
                metrics[`disk.${name}KiB`] = Number(match[1]);
            }
            expect(metrics['disk.totalKiB']).toBeGreaterThan(0);

            const receipt = {
                schemaVersion: 1,
                target: descriptor.target,
                version: descriptor.version,
                commit: descriptor.commit,
                buildId: descriptor.buildId,
                runtime: basename(new URL(descriptor.runtime.source.url).pathname),
                runtimeSource: installed.at(0)?.runtimeSource ?? 'unknown',
                sampling: {
                    settleMs: SETTLE_MS,
                    samples: SAMPLE_COUNT,
                    intervalMs: SAMPLE_INTERVAL_MS,
                },
                timings,
                metrics,
            };
            await mkdir(dirname(receiptFile!), { recursive: true });
            await writeFile(receiptFile!, `${JSON.stringify(receipt, null, 4)}\n`);
        },
        10 * 60_000,
    );
});
