#!/usr/bin/env bun

/**
 * Measures what the SSH Host Server costs a host (disk, upload, per-process memory) and gates it against
 * `scripts/server-footprint-baseline.json`. See `docs/server-footprint.md`.
 *
 *     bun run benchmark:server-footprint              # build, measure in a disposable lab, gate
 *     bun run benchmark:server-footprint --update     # same, then record the receipt as the new baseline
 *     bun run benchmark:server-footprint --compare-only   # gate the last receipt again without measuring
 *
 * `--skip-build` reuses `apps/server/dist/remote` as is, `--keep-lab` leaves the lab container running for inspection,
 * and `--port` picks the lab's loopback SSH port. The lab is built for Docker's own architecture, so an Apple silicon
 * machine measures `linux-arm64` and an Intel one `linux-x64`.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';

import { execFileAsync, runChildProcess } from './exec';
import type { FootprintBaseline, FootprintReceipt } from './server-footprint-gate';
import {
    compareFootprint,
    formatFootprintTable,
    updateFootprintBaseline,
} from './server-footprint-gate';
import { startSshLab, stopSshLab } from './ssh-lab';

const repoRoot = resolve(import.meta.dirname, '..');
const BASELINE_FILE = resolve(repoRoot, 'scripts/server-footprint-baseline.json');
const BENCHMARK_TEST = 'apps/desktop/src/main/ssh/__tests__/footprint.integration.test.ts';
const LAB_NAME = 'caxri-footprint-lab';

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

async function measure(
    receiptFile: string,
    options: { isBuildSkipped: boolean; isLabKept: boolean; port: number },
) {
    if (!options.isBuildSkipped) {
        await run('bun', ['run', 'build:workspaces']);
        await run('bun', [
            'run',
            'apps/server/scripts/build-remote-layers.ts',
            '--target',
            `linux-${await dockerArchitecture()}`,
        ]);
    }
    const lab = await startSshLab(LAB_NAME, options.port);
    try {
        await run('bunx', ['vitest', 'run', BENCHMARK_TEST], {
            CAXRI_SERVER_FOOTPRINT_RECEIPT: receiptFile,
            CAXRI_SSH_CONFIG: lab.configFile,
            CAXRI_SSH_DESTINATION: lab.destination,
            CAXRI_SSH_INTEGRATION: '1',
        });
    } finally {
        if (options.isLabKept)
            console.log(`Lab kept: CAXRI_SSH_CONFIG=${lab.configFile} ssh ${lab.destination}`);
        else await stopSshLab(LAB_NAME);
    }
}

if (import.meta.main) {
    const { values } = parseArgs({
        options: {
            'compare-only': { type: 'boolean', default: false },
            'keep-lab': { type: 'boolean', default: false },
            'port': { type: 'string', default: '2232' },
            'receipt': { type: 'string', default: 'test-results/receipts/server-footprint.json' },
            'skip-build': { type: 'boolean', default: false },
            'update': { type: 'boolean', default: false },
        },
    });
    const receiptFile = resolve(repoRoot, values.receipt);
    if (!values['compare-only'])
        await measure(receiptFile, {
            isBuildSkipped: values['skip-build'],
            isLabKept: values['keep-lab'],
            port: Number(values.port),
        });
    const receipt = JSON.parse(await readFile(receiptFile, 'utf8')) as FootprintReceipt;
    const baseline = JSON.parse(await readFile(BASELINE_FILE, 'utf8')) as FootprintBaseline;
    const comparison = compareFootprint(receipt, baseline);
    console.log(`${receipt.target} ${receipt.version} (${receipt.commit}), ${receipt.runtime}`);
    console.log(formatFootprintTable(comparison));
    if (values.update) {
        const updated = updateFootprintBaseline(baseline, receipt, new Date().toISOString());
        await writeFile(BASELINE_FILE, `${JSON.stringify(updated, null, 4)}\n`);
        console.log(`Recorded ${receipt.target} in ${BASELINE_FILE}`);
    } else if (comparison.isFailed) {
        console.error(
            comparison.blocker
                ? 'Server footprint could not be compared with the baseline; see docs/server-footprint.md'
                : 'Server footprint regressed; see docs/server-footprint.md',
        );
        process.exitCode = 1;
    } else if (comparison.rows.some((row) => row.verdict === 'improved' || row.verdict === 'new')) {
        console.log('Footprint improved or gained metrics: lock it in with --update');
    }
}
