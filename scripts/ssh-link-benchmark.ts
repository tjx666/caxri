#!/usr/bin/env bun

/**
 * Measures an SSH Host window on simulated slow links, with OpenSSH compression off and on. See
 * `docs/ssh-host.md#slow-links`.
 *
 *     bun run scripts/ssh-link-benchmark.ts                    # build, then every profile with both settings
 *     bun run scripts/ssh-link-benchmark.ts --skip-build --profiles slow --rounds 5
 *
 * Each run starts a fresh `scripts/ssh-lab.ts` container, adds one throttled lab host per link profile and compression
 * setting (a `ProxyCommand` through `scripts/ssh-link-throttle.ts`), and runs
 * `apps/desktop/src/main/ssh/__tests__/link.integration.test.ts` once per pair. The combined receipt goes to
 * `test-results/receipts/ssh-link.json`. `--keep-lab` leaves the container running.
 */

import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';

import { execFileAsync, runChildProcess } from './exec';
import type { SshLab } from './ssh-lab';
import { startSshLab, stopSshLab } from './ssh-lab';

const repoRoot = resolve(import.meta.dirname, '..');
const BENCHMARK_TEST = 'apps/desktop/src/main/ssh/__tests__/link.integration.test.ts';
const LAB_NAME = 'caxri-link-lab';

interface LinkProfile {
    kbps: number;
    /**
     * Installs over the unthrottled host instead of measuring the first install on this link.
     */
    preinstall: boolean;
    rttMs: number;
}

/**
 * `slow` is the 3G profile T3 Code publishes its load times on (400 kbps each way, 400 ms RTT); `broadband` a distant
 * cloud host on an ordinary connection; `local` the lab with no shaping, which isolates the CPU cost of compression.
 */
const PROFILES: Record<string, LinkProfile> = {
    local: { kbps: 0, rttMs: 0, preinstall: false },
    broadband: { kbps: 20_000, rttMs: 60, preinstall: false },
    slow: { kbps: 400, rttMs: 400, preinstall: true },
};

interface PhaseResult {
    downBytes: number;
    ms: number;
    samplesMs: number[];
    upBytes: number;
}

interface VariantReceipt {
    coldInstall: { downBytes: number; ms: number; runtimeSource?: string; upBytes: number } | null;
    phases: Record<string, PhaseResult>;
    rounds: number;
}

/**
 * A profile's two runs; one is missing only when the other's run failed.
 */
type VariantPair = Partial<Record<'off' | 'on', VariantReceipt>>;

async function run(
    command: string,
    argv: string[],
    environment: NodeJS.ProcessEnv = {},
): Promise<void> {
    const code = await runChildProcess(command, argv, {
        cwd: repoRoot,
        env: { ...process.env, ...environment },
        stdio: 'inherit',
    });
    if (code !== 0) throw new Error(`${command} ${argv.join(' ')} exited with ${code}`);
}

async function dockerArchitecture(): Promise<'arm64' | 'x64'> {
    const { stdout } = await execFileAsync('docker', ['version', '--format', '{{.Server.Arch}}']);
    const architecture = stdout.trim();
    if (architecture === 'arm64' || architecture === 'aarch64') return 'arm64';
    if (architecture === 'amd64' || architecture === 'x86_64') return 'x64';
    throw new Error(`Unsupported Docker architecture: ${architecture}`);
}

/**
 * Appends a lab host that reaches the same container through the throttling relay; the test sets compression itself.
 * `HostKeyAlias` reuses the host key the direct lab host already accepted.
 */
async function addLinkHost(
    configFile: string,
    labDirectory: string,
    port: number,
    host: string,
    profile: LinkProfile,
    statsDirectory: string,
): Promise<void> {
    const relay = join(repoRoot, 'scripts/ssh-link-throttle.ts');
    await appendFile(
        configFile,
        `
Host ${host}
    HostName 127.0.0.1
    User dev
    IdentityFile ${join(labDirectory, 'id_ed25519')}
    IdentitiesOnly yes
    UserKnownHostsFile ${join(labDirectory, 'known_hosts')}
    HostKeyAlias [127.0.0.1]:${port}
    StrictHostKeyChecking accept-new
    ProxyCommand ${process.execPath} run ${relay} --target 127.0.0.1:${port} --kbps ${profile.kbps} --rtt-ms ${profile.rttMs} --stats-dir ${statsDirectory}
`,
    );
}

function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
    return `${Math.round(bytes / 1024)} KiB`;
}

function formatTable(results: Record<string, VariantPair>): string {
    const lines = [
        '| Profile | Phase | Off: time | Off: down | On: time | On: down | Speedup |',
        '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
    ];
    for (const [profile, variants] of Object.entries(results)) {
        const off = variants.off;
        const on = variants.on;
        if (!off || !on) continue;
        const rows: Array<
            [string, { downBytes: number; ms: number }, { downBytes: number; ms: number }]
        > = [];
        // Only comparable when both installs fetched Node the same way.
        if (
            off.coldInstall?.runtimeSource &&
            off.coldInstall.runtimeSource === on.coldInstall?.runtimeSource
        )
            rows.push([
                `coldInstall (${off.coldInstall.runtimeSource})`,
                off.coldInstall,
                on.coldInstall,
            ]);
        for (const [phase, value] of Object.entries(off.phases))
            rows.push([phase, value, on.phases[phase]]);
        for (const [phase, left, right] of rows)
            lines.push(
                `| ${profile} | ${phase} | ${left.ms} ms | ${formatBytes(left.downBytes)} | ${right.ms} ms | ${formatBytes(right.downBytes)} | ${(left.ms / Math.max(1, right.ms)).toFixed(2)}x |`,
            );
    }
    return lines.join('\n');
}

/**
 * Runs the benchmark test once against a new throttled host for this profile and compression setting.
 */
async function runVariant(
    lab: SshLab,
    port: number,
    name: string,
    isCompressed: boolean,
    rounds: string,
): Promise<VariantReceipt> {
    const profile = PROFILES[name];
    const variant = isCompressed ? 'on' : 'off';
    const host = `link-${name}-${variant}`;
    const statsDirectory = join(lab.directory, 'stats', host);
    await rm(statsDirectory, { force: true, recursive: true });
    await mkdir(statsDirectory, { recursive: true });
    await addLinkHost(lab.configFile, lab.directory, port, host, profile, statsDirectory);
    const variantReceipt = join(lab.directory, `${host}.json`);
    console.log(
        `\n== ${name} (${profile.kbps || 'unlimited'} kbps, ${profile.rttMs} ms RTT), compression ${variant}`,
    );
    await run('bunx', ['vitest', 'run', BENCHMARK_TEST], {
        CAXRI_SSH_CONFIG: lab.configFile,
        CAXRI_SSH_DESTINATION: lab.destination,
        CAXRI_SSH_INTEGRATION: '1',
        CAXRI_SSH_LINK_COMPRESSION: isCompressed ? '1' : '0',
        CAXRI_SSH_LINK_DESTINATION: host,
        CAXRI_SSH_LINK_PREINSTALL: profile.preinstall ? '1' : '0',
        CAXRI_SSH_LINK_RECEIPT: variantReceipt,
        CAXRI_SSH_LINK_ROUNDS: rounds,
        CAXRI_SSH_LINK_STATS_DIR: statsDirectory,
    });
    return JSON.parse(await readFile(variantReceipt, 'utf8')) as VariantReceipt;
}

if (import.meta.main) {
    const { values } = parseArgs({
        options: {
            'keep-lab': { type: 'boolean', default: false },
            'port': { type: 'string', default: '2252' },
            'profiles': { type: 'string', default: Object.keys(PROFILES).join(',') },
            'receipt': { type: 'string', default: 'test-results/receipts/ssh-link.json' },
            'rounds': { type: 'string', default: '3' },
            'skip-build': { type: 'boolean', default: false },
        },
    });
    const profileNames = values.profiles.split(',');
    for (const name of profileNames)
        if (!Object.hasOwn(PROFILES, name))
            throw new Error(`Unknown profile "${name}": use ${Object.keys(PROFILES).join(', ')}`);
    if (!values['skip-build']) {
        await run('bun', ['run', 'build:workspaces']);
        await run('bun', [
            'run',
            'apps/server/scripts/build-remote-layers.ts',
            '--target',
            `linux-${await dockerArchitecture()}`,
        ]);
    }
    const port = Number(values.port);
    const lab = await startSshLab(LAB_NAME, port);
    const results: Record<string, VariantPair> = {};
    try {
        for (const name of profileNames) {
            results[name] = {};
            for (const isCompressed of [false, true])
                // eslint-disable-next-line no-await-in-loop -- variants share one lab host and must not overlap
                results[name][isCompressed ? 'on' : 'off'] = await runVariant(
                    lab,
                    port,
                    name,
                    isCompressed,
                    values.rounds,
                );
        }
    } finally {
        if (values['keep-lab'])
            console.log(`Lab kept: CAXRI_SSH_CONFIG=${lab.configFile} ssh ${lab.destination}`);
        else await stopSshLab(LAB_NAME);
    }
    const receiptFile = resolve(repoRoot, values.receipt);
    await mkdir(resolve(receiptFile, '..'), { recursive: true });
    await writeFile(receiptFile, JSON.stringify({ profiles: PROFILES, results }, null, 2));
    console.log(`\n${formatTable(results)}\n\nReceipt: ${receiptFile}`);
}
