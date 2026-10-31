#!/usr/bin/env bun

import process from 'node:process';

import { parseAndroidFlowArguments } from './android-flow-receipts';
import { listAndroidFlows, requireInstalledCaxri, runAndroidFlows } from './android-flow-runner';

const main = async (): Promise<void> => {
    const input = parseAndroidFlowArguments(process.argv.slice(2));
    requireInstalledCaxri(input.serial);
    const flows = input.flows.length > 0 ? input.flows : await listAndroidFlows();
    process.exitCode = await runAndroidFlows(input.serial, flows, 'inherit');
};

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
