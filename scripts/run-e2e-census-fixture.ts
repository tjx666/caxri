#!/usr/bin/env bun

import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import process from 'node:process';

import { writeJsonAtomic } from './atomic-json';
import { waitForChildExit } from './exec';
import type { E2EPoolReceipt } from './reporters/e2e-receipt-reporter';
import { assertE2EPoolCensusComplete } from './reporters/e2e-receipt-reporter';
import { playwrightReporterArgument } from './reporters/public-e2e-reporter-policy';
import { mergeCensusReceipts } from './run-e2e-pools';

const projectRoot = resolve(import.meta.dirname, '..');
const receiptRoot = 'test-results/receipts/census-fixture';
const config = 'scripts/fixtures/playwright-census.config.ts';

async function run(
    receiptPath: string,
    targets: string[],
    maxFailures: number,
): Promise<{ exitCode: number; output: string }> {
    const child = spawn(
        'bunx',
        [
            'playwright',
            'test',
            ...targets,
            `--config=${config}`,
            '--workers=1',
            `--max-failures=${maxFailures}`,
            playwrightReporterArgument({ includeReceipt: true }),
        ],
        {
            cwd: projectRoot,
            env: {
                ...process.env,
                CAXRI_E2E_POOL: 'census-fixture',
                CAXRI_E2E_RECEIPT_PATH: receiptPath,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        },
    );
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
    });
    const exitCode = await waitForChildExit(child);
    const output = Buffer.concat(chunks).toString('utf8');
    await writeFile(`${receiptPath}.log`, output, 'utf8');
    return { exitCode, output };
}

async function readReceipt(path: string): Promise<E2EPoolReceipt> {
    return JSON.parse(await readFile(path, 'utf8')) as E2EPoolReceipt;
}

async function writeReceipt(path: string, receipt: E2EPoolReceipt): Promise<void> {
    await writeJsonAtomic(path, receipt);
}

function testTarget(location: string): string {
    const file = location.replace(/:\d+:\d+$/u, '');
    const path = isAbsolute(file) ? relative(projectRoot, file) : file;
    const line = /:(\d+):\d+$/u.exec(location)?.[1];
    return `${path}:${line ?? '1'}`;
}

async function main(): Promise<void> {
    await mkdir(receiptRoot, { recursive: true });
    const initialPath = `${receiptRoot}/initial.json`;
    const initialResult = await run(initialPath, [], 3);
    if (initialResult.exitCode === 0) {
        throw new Error('Census fixture must retain its deterministic failures');
    }
    const initial = await readReceipt(initialPath);
    if (initial.failed !== 3 || initial.unknown !== 2) {
        throw new Error(
            `Census fixture expected 3 failures and 2 suppressed tests, received ${initial.failed}/${initial.unknown}`,
        );
    }

    const census: E2EPoolReceipt[] = [];
    const suppressedTests = initial.tests.filter(({ verdict }) => verdict === 'unknown').entries();
    for (const [index, test] of suppressedTests) {
        const path = `${receiptRoot}/rerun-${index}.json`;
        // Each suppressed test is rerun in isolation and its receipt is read back before the next
        // rerun starts, so the reruns must stay sequential rather than concurrent.
        // eslint-disable-next-line no-await-in-loop -- sequential isolated test reruns
        await run(path, [testTarget(test.location)], 1);
        // eslint-disable-next-line no-await-in-loop -- sequential isolated test reruns
        census.push(await readReceipt(path));
    }
    const combined = mergeCensusReceipts(initial, census);
    assertE2EPoolCensusComplete(combined);
    if (
        combined.failed !== 4 ||
        combined.passed !== 1 ||
        combined.failureGroups.length !== 1 ||
        combined.failureGroups[0].count !== 4
    ) {
        throw new Error('Census fixture did not preserve the complete grouped failure surface');
    }
    await writeReceipt(`${receiptRoot}/combined.json`, combined);
}

if (import.meta.main) await main();
