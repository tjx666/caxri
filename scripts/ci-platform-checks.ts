#!/usr/bin/env bun

import process from 'node:process';

import type { PlatformNeutralCIGateId } from './ci-platform-gates';
import { platformCheckCommands } from './ci-platform-gates';
import { runChildProcess } from './exec';

/**
 * Hosted CI runs these gates in their own jobs beside the remaining platform checks.
 */
const SKIP_GATE_ARGUMENTS: Readonly<Record<string, PlatformNeutralCIGateId>> = {
    '--skip-eslint': 'eslint',
    '--skip-vitest': 'vitest',
};

async function main(): Promise<void> {
    const arguments_ = process.argv.slice(2);
    const unknownArgument = arguments_.find(
        (argument) =>
            argument !== '--skip-node-pty-preparation' &&
            !Object.hasOwn(SKIP_GATE_ARGUMENTS, argument),
    );
    if (unknownArgument) throw new Error(`Unknown ci-platform-checks argument: ${unknownArgument}`);
    const isIncludeNodePtyPreparation = !arguments_.includes('--skip-node-pty-preparation');

    const checks = platformCheckCommands(process.env, {
        includeNodePtyPreparation: isIncludeNodePtyPreparation,
        skipGates: arguments_.flatMap((argument) => SKIP_GATE_ARGUMENTS[argument] ?? []),
    });
    for (const check of checks) {
        // eslint-disable-next-line no-await-in-loop -- matches the fail-fast ordering of the former workflow steps
        const result = await runChildProcess(check.command, check.arguments, { stdio: 'inherit' });
        if (result === 0) continue;
        console.error(
            `Full platform checks stopped after ${check.label} failed with exit ${result}.`,
        );
        process.exitCode = result;
        return;
    }
}

if (import.meta.main) await main();

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by focused CI contract tests
export { platformCheckCommands } from './ci-platform-gates';
