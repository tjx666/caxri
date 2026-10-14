#!/usr/bin/env bun

import type { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';

import {
    acquireDesktopLease,
    releaseDesktopLease,
} from '../.agents/skills/switch-worktree/scripts/desktop-lease';
import { waitForChildExit } from './exec';
import { playwrightReporterArgument } from './reporters/public-e2e-reporter';

const projectRoot = resolve(import.meta.dirname, '..');

const cascadePatterns = [
    /Desktop is in use by/u,
    /repository lock owner metadata/u,
    /left a (?:active|stale) e2e-worker/u,
];

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/run-e2e-failure-isolation.test.ts
export function validateFailureIsolationResult(
    exitCode: number,
    output: string,
): { originalFailure: true; replacementPassed: true } {
    if (exitCode === 0) {
        throw new Error('Failure-isolation probe must retain its original non-zero result');
    }
    if (cascadePatterns.some((pattern) => pattern.test(output))) {
        throw new Error('Failure-isolation probe produced a lock or lease cascade');
    }
    if (!/1 failed/u.test(output)) {
        throw new Error('Failure-isolation probe did not retain exactly one original failure');
    }
    if (!/1 passed/u.test(output)) {
        throw new Error('Failure-isolation replacement worker did not pass');
    }
    return { originalFailure: true, replacementPassed: true };
}

async function main(): Promise<void> {
    const coordinator = await acquireDesktopLease(projectRoot, 'E2E failure-isolation coordinator');
    const child = spawn(
        'bunx',
        [
            'playwright',
            'test',
            'e2e/failure-isolation.e2e.ts',
            '--workers=1',
            '--max-failures=2',
            playwrightReporterArgument(),
        ],
        {
            cwd: projectRoot,
            env: {
                ...process.env,
                CAXRI_E2E_COORDINATOR_TOKEN: coordinator.token,
                CAXRI_E2E_FAILURE_ISOLATION: '1',
                CAXRI_E2E_OUTPUT_DIR: 'test-results/failure-isolation',
                CAXRI_E2E_POOL: 'parallel-safe',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        },
    );
    let output = '';
    const capture = (chunk: Buffer): void => {
        const text = chunk.toString();
        output += text;
        process.stdout.write(text);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    let exitCode: number;
    try {
        exitCode = await waitForChildExit(child);
    } finally {
        await releaseDesktopLease(coordinator);
    }
    validateFailureIsolationResult(exitCode, output);
}

if (import.meta.main) await main();
