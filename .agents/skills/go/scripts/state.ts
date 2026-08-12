#!/usr/bin/env bun

export * from './state-model';
import { runStateCli } from './state-cli';

if (import.meta.main) {
    void runStateCli(process.argv.slice(2)).catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
