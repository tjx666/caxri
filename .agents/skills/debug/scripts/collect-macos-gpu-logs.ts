#!/usr/bin/env bun

import { execFile } from 'node:child_process';
import process from 'node:process';
import { promisify } from 'node:util';

import { parseMacosGpuLogWindow } from './macos-gpu-log-query';
import { buildMacosGpuLogReceipt } from './macos-gpu-log-receipt';

const execFileAsync = promisify(execFile);

const PREDICATE =
    '(process == "Caxri Helper (GPU)" OR process == "WindowServer" OR process == "Dock" OR process == "kernel") AND ' +
    '(eventMessage CONTAINS[c] "GPU" OR eventMessage CONTAINS[c] "IOGPU" OR eventMessage CONTAINS[c] "Metal" OR ' +
    'eventMessage CONTAINS[c] "shared event" OR eventMessage CONTAINS[c] "Space" OR eventMessage CONTAINS[c] "full screen")';

async function main(): Promise<void> {
    if (process.platform !== 'darwin') throw new Error('macOS unified logs require macOS');
    const { start, end } = parseMacosGpuLogWindow(process.argv.slice(2));
    const { stdout } = await execFileAsync(
        '/usr/bin/log',
        ['show', '--style', 'ndjson', '--start', start, '--end', end, '--predicate', PREDICATE],
        { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
    );
    console.log(JSON.stringify(buildMacosGpuLogReceipt(stdout), null, 2));
}

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
