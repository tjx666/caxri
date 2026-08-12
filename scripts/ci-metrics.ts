#!/usr/bin/env bun

import { appendFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

interface ProcessSample {
    pid: number;
    ppid: number;
    rssKiB: number;
}

export function processTreeRSSKiB(snapshot: string, rootPid: number): number | undefined {
    const processes = snapshot.split('\n').flatMap((line): ProcessSample[] => {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/u.exec(line);
        return match
            ? [{ pid: Number(match[1]), ppid: Number(match[2]), rssKiB: Number(match[3]) }]
            : [];
    });
    const byPid = new Map(processes.map((process) => [process.pid, process]));
    if (!byPid.has(rootPid)) return undefined;
    const children = new Map<number, number[]>();
    for (const process of processes) {
        const siblings = children.get(process.ppid) ?? [];
        siblings.push(process.pid);
        children.set(process.ppid, siblings);
    }
    let total = 0;
    const pending = [rootPid];
    const visited = new Set<number>();
    while (pending.length > 0) {
        const pid = pending.pop()!;
        if (visited.has(pid)) continue;
        visited.add(pid);
        total += byPid.get(pid)?.rssKiB ?? 0;
        pending.push(...(children.get(pid) ?? []));
    }
    return total;
}

async function processSnapshot(): Promise<string> {
    const child = spawn('ps', ['-axo', 'pid=,ppid=,rss='], {
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    return await new Promise<string>((resolveSnapshot) => {
        child.once('error', () => resolveSnapshot(''));
        child.once('exit', (code) => resolveSnapshot(code === 0 ? stdout : ''));
    });
}

function parseArguments(argv: string[]): { args: string[]; command: string; label: string } {
    if (argv[0] !== '--label' || !argv[1] || argv[2] !== '--' || !argv[3]) {
        throw new Error('Usage: ci-metrics --label <label> -- <command> [args...]');
    }
    return { args: argv.slice(4), command: argv[3], label: argv[1] };
}

async function main(): Promise<void> {
    const { args, command, label } = parseArguments(process.argv.slice(2));
    const started = performance.now();
    const child = spawn(command, args, { env: process.env, stdio: 'inherit' });
    const childPid = child.pid;
    if (!childPid) throw new Error(`Could not start metrics command: ${command}`);
    let peakRSSKiB: number | undefined;
    let samplePending = false;
    const sample = async (): Promise<void> => {
        if (samplePending) return;
        samplePending = true;
        try {
            const rss = processTreeRSSKiB(await processSnapshot(), childPid);
            if (rss !== undefined) peakRSSKiB = Math.max(peakRSSKiB ?? 0, rss);
        } finally {
            samplePending = false;
        }
    };
    await sample();
    const timer = setInterval(() => void sample(), 250);
    const exitCode = await new Promise<number>((resolveExit, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolveExit(code ?? (signal ? 1 : 0)));
    });
    clearInterval(timer);
    const elapsedSeconds = (performance.now() - started) / 1_000;
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) {
        const safeLabel = label.replace(/[\r\n|]/gu, ' ');
        const peak =
            peakRSSKiB === undefined ? 'unavailable' : `${(peakRSSKiB / 1_024).toFixed(1)} MiB`;
        await appendFile(
            summary,
            `- ${safeLabel}: ${elapsedSeconds.toFixed(1)}s wall, ${peak} peak RSS, exit ${exitCode}\n`,
        );
    }
    process.exitCode = exitCode;
}

if (import.meta.main) await main();
