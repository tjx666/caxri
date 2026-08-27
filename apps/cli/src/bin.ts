#!/usr/bin/env node

import process from 'node:process';
import { createInterface } from 'node:readline/promises';

import { runCli } from './application.js';

async function main(): Promise<void> {
    const controller = new AbortController();
    const interrupt = (): void => controller.abort();
    process.once('SIGINT', interrupt);
    const exitCode = await runCli(process.argv.slice(2), {
        environment: process.env,
        signal: controller.signal,
        confirm: async (message) => {
            const prompt = createInterface({ input: process.stdin, output: process.stderr });
            try {
                const answer = await prompt.question(`${message} [y/N] `);
                return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
            } finally {
                prompt.close();
            }
        },
    });
    process.removeListener('SIGINT', interrupt);
    process.exitCode = exitCode;
}

/**
 * `build:cli` bundles this entrypoint with `bun build --format=cjs`, and Bun's CJS target rejects top-level `await`, so
 * the rejection handler stays promise-chained instead.
 */
// eslint-disable-next-line unicorn/prefer-await -- CJS bundle target, see above
main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
});
