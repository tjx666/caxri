#!/usr/bin/env bun

import process from 'node:process';

import { runStateCli } from './state-cli';

if (import.meta.main) {
    try {
        await runStateCli(process.argv.slice(2));
    } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
