import type { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import type { ServerClient } from '@caxri/client/supervise';
import { connectDesktopWithCredential } from '@caxri/client/supervise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseSshDestination } from '../destination';
import { SshHostServerSupervisor } from '../server-supervisor';
import type { SshConnectionOptions } from '../ssh-connection';
import { SshConnection } from '../ssh-connection';
import { makeShortTemporaryDirectory } from './support/fixtures';
import {
    isSshIntegrationEnabled,
    labConfigFile,
    labDestination,
    resetRemoteServerScript,
} from './support/ssh-lab';

/**
 * The SSH Host slow-link benchmark: drives a real Desktop workload against the lab host through
 * `scripts/ssh-link-throttle.ts`, a `ProxyCommand` that simulates a bandwidth- and latency-limited link and counts the
 * bytes that really cross it. Run it through `scripts/ssh-link-benchmark.ts`, which writes one throttled lab host per
 * link profile and SSH compression setting; see `docs/ssh-host.md#slow-links`.
 *
 * Opt-in: the lab variables of the SSH integration suites, plus `CAXRI_SSH_LINK_RECEIPT=<file>`,
 * `CAXRI_SSH_LINK_DESTINATION` (the throttled host the supervisor uses), and `CAXRI_SSH_LINK_STATS_DIR` (where the
 * relay keeps its byte counts). Fixture setup and resets go over the unthrottled `CAXRI_SSH_DESTINATION` so they never
 * count against the link.
 *
 * The Project is this repository's own tracked tree, so listings, reads, diffs, and search carry real source-sized
 * payloads instead of one-line fixtures.
 */
const receiptFile = process.env.CAXRI_SSH_LINK_RECEIPT;
const linkDestination = process.env.CAXRI_SSH_LINK_DESTINATION;
const statsDirectory = process.env.CAXRI_SSH_LINK_STATS_DIR;
const rounds = Number(process.env.CAXRI_SSH_LINK_ROUNDS ?? '3');
/**
 * Installs over the unthrottled host and skips the cold-install measurement: on a 400 kbps link the ~50 MB first
 * install takes most of an hour and says nothing about the everyday workload.
 */
const isPreinstalled = process.env.CAXRI_SSH_LINK_PREINSTALL === '1';
/**
 * `0` turns OpenSSH compression off on the throttled masters, which Caxri otherwise always negotiates.
 */
const isCompressed = process.env.CAXRI_SSH_LINK_COMPRESSION !== '0';
const repoRoot = resolve(import.meta.dirname, '../../../../../..');
const layersRoot = resolve(repoRoot, 'apps/server/dist/remote');
const PROJECT_FOLDER = 'caxri-link-project';
const RESET_SCRIPT = resetRemoteServerScript(PROJECT_FOLDER);

/**
 * Text files a reader plausibly opens, from a lockfile down to an ordinary module.
 */
const READ_PATHS = [
    'pnpm-lock.yaml',
    'GLOSSARY.md',
    'docs/agent-chat.md',
    'apps/desktop/src/main/index.ts',
    'packages/protocol/src/domain/git-contract.ts',
];
/**
 * Working changes with a diff each: appended lines in ordinary modules plus one rewritten large document.
 */
const DIFF_PATHS = [
    'docs/agent-chat.md',
    'apps/desktop/src/main/index.ts',
    'packages/protocol/src/domain/git-contract.ts',
    'packages/protocol/src/domain/file-contract.ts',
    'scripts/ssh-lab.ts',
];
const LIST_DIRECTORIES = ['apps', 'packages', 'docs', 'scripts', 'apps/desktop/src/main'];

interface LinkStats {
    downBytes: number;
    upBytes: number;
}

const PHASES = ['attach', 'openProject', 'list', 'read', 'gitSummary', 'diffs', 'search'] as const;
type Phase = (typeof PHASES)[number];

interface PhaseSample {
    downBytes: number;
    ms: number;
    upBytes: number;
}

function median(values: number[]): number {
    const sorted = values.toSorted((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sums every relay's totals. Each `ProxyCommand` process keeps its own file, refreshed every 200 ms, so a short wait
 * before reading lets the last bytes of a phase land.
 */
async function readLinkStats(): Promise<LinkStats> {
    await delay(400);
    const names = (await readdir(statsDirectory!)).filter((name) => name.endsWith('.json'));
    const texts = await Promise.all(
        names.map((name) => readFile(join(statsDirectory!, name), 'utf8')),
    );
    const total: LinkStats = { downBytes: 0, upBytes: 0 };
    for (const text of texts) {
        const stats = JSON.parse(text) as LinkStats;
        total.downBytes += stats.downBytes;
        total.upBytes += stats.upBytes;
    }
    return total;
}

async function gitArchive(): Promise<Buffer> {
    const { stdout } = await promisify(execFile)('git', ['archive', '--format=tar', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'buffer',
        maxBuffer: 512 * 1024 * 1024,
    });
    return stdout;
}

describe.skipIf(!isSshIntegrationEnabled || !receiptFile || !linkDestination || !statsDirectory)(
    'SSH Host on a slow link',
    () => {
        let root: string;
        let control: SshConnection | undefined;
        /**
         * How the cold install obtained Node (`remote-download` or `local-upload`): the two move 5 MB or 50 MB over the
         * link, so a cold-install time means nothing without it.
         */
        let runtimeSource: unknown;
        const supervisors: SshHostServerSupervisor[] = [];
        const openClients: ServerClient[] = [];

        function createSupervisor(destination = linkDestination!): SshHostServerSupervisor {
            const supervisor = new SshHostServerSupervisor({
                askpass: () => Promise.resolve(null),
                ...(labConfigFile !== undefined && { configFile: labConfigFile }),
                destination,
                electronExecutable: process.execPath,
                logger: {
                    write: (_level, event, options) => {
                        if (event === 'ssh_host.installed')
                            runtimeSource = options?.fields?.runtimeSource;
                    },
                },
                onState: () => {},
                privateDirectory: join(root, `ctl-${supervisors.length}`),
                remoteLayersRoot: layersRoot,
                runtimeCacheDirectory: join(root, 'runtimes'),
                createTransport: (options: SshConnectionOptions) =>
                    new SshConnection({ ...options, compression: isCompressed }),
            });
            supervisors.push(supervisor);
            return supervisor;
        }

        /**
         * Times `work` and the link bytes it moved.
         */
        async function measure(work: () => Promise<void>): Promise<PhaseSample> {
            const before = await readLinkStats();
            const startedAt = performance.now();
            await work();
            const ms = Math.round(performance.now() - startedAt);
            const after = await readLinkStats();
            return {
                ms,
                downBytes: after.downBytes - before.downBytes,
                upBytes: after.upBytes - before.upBytes,
            };
        }

        /**
         * One round on a fresh Desktop connection: a new supervisor adopts the running Server, as a reopened window
         * does, then the Project workload runs phase by phase.
         */
        async function runRound(round: number): Promise<Record<Phase, PhaseSample>> {
            let desktop: ServerClient | undefined;
            const attach = await measure(async () => {
                const supervisor = createSupervisor();
                openClients.push(await supervisor.ensure(120_000));
                const { credential, manifest } = await supervisor.discoverDesktop();
                desktop = await connectDesktopWithCredential(
                    manifest,
                    credential,
                    `link-desktop-${round}`,
                    () => Promise.resolve(null),
                    60_000,
                );
                openClients.push(desktop);
                await desktop.request('app.bootstrap', {});
            });
            const client = desktop!;
            let sessionId = '';
            let projectRoot = '';
            const openProject = await measure(async () => {
                const browsed = await client.request('project.browseFolders', {});
                const entry = browsed.entries.find(
                    (candidate) => candidate.name === PROJECT_FOLDER,
                );
                expect(entry).toBeDefined();
                projectRoot = entry?.path ?? '';
                const project = await client.requestServerOperation('project.create', {
                    rootPath: projectRoot,
                });
                const { session } = await client.request('session.create', {
                    projectId: project.id,
                    defaultAgent: null,
                });
                await client.request('session.select', { sessionId: session.id });
                sessionId = session.id;
            });
            const list = await measure(async () => {
                await client.request('files.list', { sessionId });
                await Promise.all(
                    LIST_DIRECTORIES.map((directory) =>
                        client.request('files.list', {
                            sessionId,
                            directory: `${projectRoot}/${directory}`,
                        }),
                    ),
                );
            });
            const read = await measure(async () => {
                await Promise.all(
                    READ_PATHS.map((path) =>
                        client.request('files.read', {
                            sessionId,
                            path: `${projectRoot}/${path}`,
                        }),
                    ),
                );
            });
            let repoId = '';
            const gitSummary = await measure(async () => {
                const summary = await client.request('git.summary', {
                    sessionId,
                    refresh: round + 1,
                });
                repoId = summary.repositories[0]?.id ?? '';
            });
            expect(repoId).not.toBe('');
            const diffs = await measure(async () => {
                const documents = await Promise.all(
                    DIFF_PATHS.map((path) =>
                        client.request('git.diffDocument', {
                            sessionId,
                            repositoryId: repoId,
                            path: `${projectRoot}/${path}`,
                        }),
                    ),
                );
                expect(documents.every((document) => document !== null)).toBe(true);
            });
            const search = await measure(async () => {
                const result = await client.request('files.search', {
                    sessionId,
                    consumer: 'project-search',
                    mode: 'content',
                    query: 'sessionId',
                });
                expect(result.matches.length).toBeGreaterThan(0);
            });
            return { attach, openProject, list, read, gitSummary, diffs, search };
        }

        beforeAll(async () => {
            root = await makeShortTemporaryDirectory('link');
            control = new SshConnection({
                ...(labConfigFile !== undefined && { configFile: labConfigFile }),
                controlDirectory: join(root, 'reset'),
                destination: parseSshDestination(labDestination),
            });
            await control.start();
            await control.exec(RESET_SCRIPT, { timeoutMs: 30_000 });
            const { Readable } = await import('node:stream');
            await control.exec(
                String.raw`set -eu
root="$HOME/${PROJECT_FOLDER}"
mkdir -p "$root"
tar -xf - -C "$root"
cd "$root"
git init -q -b main
git add -A
git -c user.name=Caxri -c user.email=link@example.invalid commit -q -m fixture
for path in ${DIFF_PATHS.join(' ')}; do printf '\n// changed for the link benchmark\n' >> "$path"; done
`,
                { stdin: Readable.from(await gitArchive()), timeoutMs: 300_000 },
            );
        }, 400_000);

        afterAll(async () => {
            for (const client of openClients) client.close();
            await Promise.all(supervisors.map((supervisor) => supervisor.dispose()));
            if (control?.isOpen) await control.exec(RESET_SCRIPT, { timeoutMs: 30_000 });
            await control?.stop();
            if (root) await rm(root, { force: true, recursive: true });
        }, 60_000);

        it(
            'measures install and a Desktop workload over the link',
            async () => {
                let coldInstall: PhaseSample | null = null;
                if (isPreinstalled) {
                    const installer = createSupervisor(labDestination);
                    openClients.push(await installer.ensure(600_000));
                } else {
                    coldInstall = await measure(async () => {
                        const supervisor = createSupervisor();
                        openClients.push(await supervisor.ensure(600_000));
                    });
                }

                const samples: Array<Record<Phase, PhaseSample>> = [];
                for (let round = 0; round < rounds; round += 1)
                    // eslint-disable-next-line no-await-in-loop -- rounds share one Server and must not overlap
                    samples.push(await runRound(round));

                const phases = Object.fromEntries(
                    PHASES.map((phase) => {
                        const values = samples.map((sample) => sample[phase]);
                        return [
                            phase,
                            {
                                ms: median(values.map((value) => value.ms)),
                                downBytes: median(values.map((value) => value.downBytes)),
                                upBytes: median(values.map((value) => value.upBytes)),
                                samplesMs: values.map((value) => value.ms),
                            },
                        ];
                    }),
                );
                await writeFile(
                    receiptFile!,
                    JSON.stringify(
                        {
                            coldInstall: coldInstall && { ...coldInstall, runtimeSource },
                            compression: isCompressed,
                            phases,
                            rounds,
                        },
                        null,
                        2,
                    ),
                );
            },
            30 * 60_000,
        );
    },
);
