#!/usr/bin/env bun

import process from 'node:process';

import type { StartInput } from './start-core';
import { startGoRun } from './start-core';

function parse(argv: string[]): StartInput {
    const values = new Map<string, string>();
    for (let index = 0; index < argv.length; index += 2) {
        // `index < argv.length` (loop condition) guarantees `key` is in bounds.
        const key = argv[index];
        const value = argv[index + 1];
        if (!value || !key.startsWith('--')) throw new Error('Expected --option value pairs');
        values.set(key.slice(2), value);
    }
    const objective = values.get('objective');
    const branch = values.get('branch');
    if (!objective || !branch) throw new Error('Go start requires --objective and --branch');
    return { branch, objective, runId: values.get('run-id') };
}

async function main(): Promise<void> {
    const result = await startGoRun(parse(process.argv.slice(2)), process.cwd());
    console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) {
    try {
        await main();
    } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
