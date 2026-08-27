#!/usr/bin/env bun

import process from 'node:process';
import { parseArgs } from 'node:util';

import { compareCandidate, recordBaseline, verifyBaseline } from './refactor-parity/core';
import {
    diagnoseRefactorOwner,
    readOwnerDiagnosticProbes,
} from './refactor-parity/owner-diagnostics';

function required(values: Record<string, unknown>, name: string): string {
    const value = values[name];
    if (typeof value !== 'string' || value.length === 0) throw new Error(`--${name} is required`);
    return value;
}

function help(): string {
    return `Architecture refactor parity runner

Usage:
  refactor-parity record --baseline-id ID --artifact PATH --catalog PATH --receipt PATH --normalization PATH --allowlist PATH --output-root PATH --startup-executable PATH
  refactor-parity verify-baseline --baseline PATH
  refactor-parity diagnose-owner --user-data-path PATH --probes PATH
  refactor-parity compare --baseline PATH --candidate-artifact PATH --candidate-receipt PATH --batch BATCH [--output PATH]`;
}

async function main(argv: string[]): Promise<void> {
    const command = argv[0];
    if (!command || command === '--help') {
        process.stdout.write(`${help()}\n`);
        return;
    }
    const { values } = parseArgs({
        args: argv.slice(1),
        options: {
            'allowlist': { type: 'string' },
            'artifact': { type: 'string' },
            'baseline': { type: 'string' },
            'baseline-id': { type: 'string' },
            'batch': { type: 'string' },
            'candidate-artifact': { type: 'string' },
            'candidate-receipt': { type: 'string' },
            'catalog': { type: 'string' },
            'normalization': { type: 'string' },
            'output': { type: 'string' },
            'output-root': { type: 'string' },
            'probes': { type: 'string' },
            'receipt': { type: 'string' },
            'startup-executable': { type: 'string' },
            'user-data-path': { type: 'string' },
        },
        strict: true,
    });
    if (command === 'record') {
        const baselineDirectory = await recordBaseline({
            allowlistPath: required(values, 'allowlist'),
            artifactPath: required(values, 'artifact'),
            baselineId: required(values, 'baseline-id'),
            catalogPath: required(values, 'catalog'),
            normalizationPath: required(values, 'normalization'),
            outputRoot: required(values, 'output-root'),
            receiptPath: required(values, 'receipt'),
            startupExecutableRelativePath: required(values, 'startup-executable'),
        });
        process.stdout.write(`${JSON.stringify({ baselineDirectory, status: 'recorded' })}\n`);
        return;
    }
    if (command === 'verify-baseline') {
        const result = await verifyBaseline(required(values, 'baseline'));
        process.stdout.write(
            `${JSON.stringify({ baselineId: result.manifest.baselineId, failures: result.failures, status: result.failures.length === 0 ? 'pass' : 'fail' })}\n`,
        );
        if (result.failures.length > 0) process.exitCode = 1;
        return;
    }
    if (command === 'diagnose-owner') {
        const result = await diagnoseRefactorOwner({
            probes: await readOwnerDiagnosticProbes(required(values, 'probes')),
            userDataPath: required(values, 'user-data-path'),
        });
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return;
    }
    if (command === 'compare') {
        const result = await compareCandidate(
            required(values, 'baseline'),
            required(values, 'candidate-receipt'),
            required(values, 'candidate-artifact'),
            typeof values.output === 'string' ? values.output : undefined,
            required(values, 'batch'),
        );
        process.stdout.write(`${JSON.stringify(result)}\n`);
        if (result.status !== 'pass') process.exitCode = 1;
        return;
    }
    throw new Error(`Unknown command: ${command}`);
}

if (import.meta.main) {
    try {
        await main(process.argv.slice(2));
    } catch (error: unknown) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
