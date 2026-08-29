#!/usr/bin/env bun

import process from 'node:process';

import { runStateCli } from './state-cli';

if (import.meta.main) {
    try {
        const exitCode = await runStateCli(process.argv.slice(2));
        if (typeof exitCode === 'number') process.exitCode = exitCode;
    } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
