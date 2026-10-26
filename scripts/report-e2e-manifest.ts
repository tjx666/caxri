#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

import { writeJsonAtomic } from './atomic-json';
import type {
    E2EFailureGroup,
    E2EPoolReceipt,
    E2ETestReceipt,
} from './reporters/e2e-receipt-reporter';
import {
    assertE2EPoolCensusComplete,
    assertE2EPoolReceipt,
} from './reporters/e2e-receipt-reporter';

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/report-e2e-manifest.test.ts
export interface E2EManifestSummary {
    failed: number;
    failureGroups: E2EFailureGroup[];
    finished: number;
    hash: string;
    passed: number;
    planned: number;
    pools: string[];
    skipped: number;
    started: number;
    status: 'failed' | 'passed';
    timedOut: number;
    unknown: number;
}

/**
 * Verifies the union of actual pool executions, rather than collecting a separate test list.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/report-e2e-manifest.test.ts
export function summarizeE2EReceipts(receipts: readonly E2EPoolReceipt[]): E2EManifestSummary {
    if (receipts.length === 0) throw new Error('At least one E2E pool receipt is required');
    for (const receipt of receipts) {
        assertE2EPoolReceipt(receipt);
        assertE2EPoolCensusComplete(receipt);
    }
    const poolNames = receipts.map((receipt) => receipt.pool);
    if (new Set(poolNames).size !== poolNames.length) {
        throw new Error('E2E receipt pools must be unique');
    }
    const tests = receipts.flatMap((receipt) => receipt.tests);
    if (new Set(tests.map((test) => test.id)).size !== tests.length) {
        throw new Error('E2E pool receipts overlap in executed tests');
    }
    const planned = receipts.reduce((total, receipt) => total + receipt.planned, 0);
    if (tests.length !== planned) {
        throw new Error('E2E receipt test list does not match its planned count');
    }
    const finished = receipts.reduce((total, receipt) => total + receipt.finished, 0);
    const groupedFailures = new Map<string, string[]>();
    const failureGroupLists = receipts.flatMap(({ failureGroups }) => failureGroups);
    for (const group of failureGroupLists) {
        groupedFailures.set(group.identity, [
            ...(groupedFailures.get(group.identity) ?? []),
            ...group.testIds,
        ]);
    }
    const hash = createHash('sha256')
        .update(
            JSON.stringify(
                [...tests]
                    .toSorted((left, right) => left.id.localeCompare(right.id))
                    .map(({ id, location, title }: E2ETestReceipt) => ({ id, location, title })),
            ),
        )
        .digest('hex');
    return {
        failed: receipts.reduce((total, receipt) => total + receipt.failed, 0),
        failureGroups: [...groupedFailures].map(([identity, testIds]) => ({
            count: testIds.length,
            identity,
            testIds: testIds.toSorted((left, right) => left.localeCompare(right)),
        })),
        finished,
        hash,
        passed: receipts.reduce((total, receipt) => total + receipt.passed, 0),
        planned,
        pools: [...poolNames].toSorted((left, right) => left.localeCompare(right)),
        skipped: receipts.reduce((total, receipt) => total + receipt.skipped, 0),
        started: receipts.reduce((total, receipt) => total + receipt.started, 0),
        status: receipts.every((receipt) => receipt.status === 'passed') ? 'passed' : 'failed',
        timedOut: receipts.reduce((total, receipt) => total + receipt.timedOut, 0),
        unknown: receipts.reduce((total, receipt) => total + receipt.unknown, 0),
    };
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/report-e2e-manifest.test.ts
export function formatE2EManifestMetric(manifest: E2EManifestSummary): string {
    return `CAXRI_E2E_MANIFEST ${JSON.stringify(manifest)}`;
}

async function main(): Promise<void> {
    const pools = process.argv.slice(2);
    if (pools.length === 0) {
        throw new Error('Usage: report-e2e-manifest.ts <pool> [pool...]');
    }
    const receipts = await Promise.all(
        pools.map(async (pool) => {
            const path = resolve('test-results/receipts', `${pool}.json`);
            return JSON.parse(await readFile(path, 'utf8')) as E2EPoolReceipt;
        }),
    );
    const manifest = summarizeE2EReceipts(receipts);
    const output = resolve('test-results/receipts/combined.json');
    await writeJsonAtomic(output, manifest);
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) {
        await appendFile(
            summary,
            [
                '## E2E execution receipt',
                '',
                '| Pools | Planned | Started | Finished | Passed | Skipped | Failed | Timeout | Unknown | Root causes | Result | SHA-256 |',
                '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |',
                `| ${manifest.pools.map((pool) => `\`${pool}\``).join(', ')} | ${manifest.planned} | ${manifest.started} | ${manifest.finished} | ${manifest.passed} | ${manifest.skipped} | ${manifest.failed} | ${manifest.timedOut} | ${manifest.unknown} | ${manifest.failureGroups.length} | ${manifest.status} | \`${manifest.hash}\` |`,
                '',
            ].join('\n'),
            'utf8',
        );
    }
    process.stdout.write(`${formatE2EManifestMetric(manifest)}\n`);
}

if (import.meta.main) await main();
