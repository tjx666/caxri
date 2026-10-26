import { readFile } from 'node:fs/promises';
import os from 'node:os';
import process from 'node:process';

import { execFileAsync } from '../filesystem/exec.js';
import { safeProcessEnvironment } from './environment.js';

const SYSTEM_QUERY_TIMEOUT_MS = 2_000;
const BYTES_PER_MB = 1024 * 1024;

export interface SystemMemory {
    totalMb: number;
    /**
     * Memory the system cannot hand to a new process without evicting someone. On macOS this is Activity Monitor's
     * "Memory Used" (App Memory + Wired + Compressed); `os.freemem()` there counts only never-touched pages and would
     * report a healthy Mac as nearly full.
     */
    usedMb: number;
    /**
     * Swap in use, where the platform reports it.
     */
    swapUsedMb?: number;
    /**
     * Set when the platform's own reading failed and `usedMb` is the coarse `os.totalmem() - os.freemem()`, which on
     * macOS overstates use; the caller logs it so a phone showing a nearly full Mac can be explained.
     */
    fallbackReason?: 'tool-failed' | 'unrecognized-output';
}

const roundMb = (bytes: number): number => Math.round((bytes / BYTES_PER_MB) * 10) / 10;

/**
 * Activity Monitor's "Memory Used" from `vm_stat`: anonymous pages that cannot be purged (App Memory), wired pages, and
 * the pages the compressor occupies. File-backed cache is excluded because the kernel reclaims it on demand. Termany
 * reads memory the same way (`vm_stat` plus `sysctl vm.swapusage`); only the approach is shared, its code is AGPL.
 */
export function parseVmStatUsedBytes(output: string): number | undefined {
    const pageSize = Number(/page size of (\d+) bytes/.exec(output)?.[1]);
    if (!Number.isFinite(pageSize) || pageSize <= 0) return;
    const pages = new Map<string, number>();
    for (const line of output.split('\n')) {
        const separator = line.lastIndexOf(':');
        if (separator <= 0) continue;
        const value = Number(
            line
                .slice(separator + 1)
                .trim()
                .replace(/\.$/, ''),
        );
        if (Number.isFinite(value)) pages.set(line.slice(0, separator).trim(), value);
    }
    const anonymous = pages.get('Anonymous pages');
    const wired = pages.get('Pages wired down');
    const compressor = pages.get('Pages occupied by compressor');
    if (anonymous === undefined || wired === undefined || compressor === undefined) return;
    const appPages = Math.max(0, anonymous - (pages.get('Pages purgeable') ?? 0));
    return (appPages + wired + compressor) * pageSize;
}

const SWAP_UNIT_BYTES: Readonly<Record<string, number>> = {
    K: 1024,
    M: BYTES_PER_MB,
    G: 1024 * BYTES_PER_MB,
};

/**
 * Parses `sysctl -n vm.swapusage`, e.g. `total = 2048.00M used = 1018.25M free = 1029.75M (encrypted)`.
 */
export function parseSwapUsageBytes(output: string): number | undefined {
    const match = /used\s*=\s*(\d+(?:\.\d+)?)([KMG])/.exec(output);
    if (!match) return;
    return Number(match[1]) * (SWAP_UNIT_BYTES[match[2]] ?? 1);
}

/**
 * Linux `/proc/meminfo`: used is total minus `MemAvailable`, the kernel's own estimate of what a new process could get;
 * swap is `SwapTotal - SwapFree`. Values are in kB.
 */
export function parseMeminfo(
    output: string,
): { totalBytes: number; usedBytes: number; swapUsedBytes?: number } | undefined {
    const fields = new Map<string, number>();
    for (const line of output.split('\n')) {
        const match = /^(\w+):\s+(\d+)\s*kB/.exec(line);
        if (match) fields.set(match[1], Number(match[2]) * 1024);
    }
    const total = fields.get('MemTotal');
    const available = fields.get('MemAvailable');
    if (total === undefined || available === undefined) return;
    const swapTotal = fields.get('SwapTotal');
    const swapFree = fields.get('SwapFree');
    return {
        totalBytes: total,
        usedBytes: Math.max(0, total - available),
        ...(swapTotal !== undefined &&
            swapFree !== undefined && { swapUsedBytes: Math.max(0, swapTotal - swapFree) }),
    };
}

async function run(file: string, arguments_: string[]): Promise<string> {
    const { stdout } = await execFileAsync(file, arguments_, {
        encoding: 'utf8',
        env: safeProcessEnvironment(),
        timeout: SYSTEM_QUERY_TIMEOUT_MS,
    });
    return stdout;
}

async function sampleDarwinMemory(): Promise<SystemMemory> {
    const totalBytes = os.totalmem();
    const [vmStat, swap] = await Promise.allSettled([
        run('/usr/bin/vm_stat', []),
        run('/usr/sbin/sysctl', ['-n', 'vm.swapusage']),
    ]);
    const parsed = vmStat.status === 'fulfilled' ? parseVmStatUsedBytes(vmStat.value) : undefined;
    const usedBytes = parsed ?? totalBytes - os.freemem();
    const swapBytes = swap.status === 'fulfilled' ? parseSwapUsageBytes(swap.value) : undefined;
    return {
        totalMb: roundMb(totalBytes),
        usedMb: roundMb(Math.min(usedBytes, totalBytes)),
        ...(swapBytes !== undefined && { swapUsedMb: roundMb(swapBytes) }),
        ...(parsed === undefined && {
            fallbackReason: vmStat.status === 'fulfilled' ? 'unrecognized-output' : 'tool-failed',
        }),
    };
}

async function sampleLinuxMemory(): Promise<SystemMemory | SystemMemory['fallbackReason']> {
    try {
        const parsed = parseMeminfo(await readFile('/proc/meminfo', 'utf8'));
        if (!parsed) return 'unrecognized-output';
        return {
            totalMb: roundMb(parsed.totalBytes),
            usedMb: roundMb(parsed.usedBytes),
            ...(parsed.swapUsedBytes !== undefined && {
                swapUsedMb: roundMb(parsed.swapUsedBytes),
            }),
        };
    } catch {
        return 'tool-failed';
    }
}

/**
 * Whole-machine memory, read the way the platform's own monitor reads it. Falls back to `os.totalmem() - os.freemem()`
 * when the platform tool is missing or its output is unrecognized.
 */
export async function sampleSystemMemory(
    platform: NodeJS.Platform = process.platform,
): Promise<SystemMemory> {
    if (platform === 'darwin') return sampleDarwinMemory();
    const linux = platform === 'linux' ? await sampleLinuxMemory() : undefined;
    if (typeof linux === 'object') return linux;
    const totalBytes = os.totalmem();
    return {
        totalMb: roundMb(totalBytes),
        usedMb: roundMb(totalBytes - os.freemem()),
        ...(linux && { fallbackReason: linux }),
    };
}

interface CpuTimes {
    busy: number;
    total: number;
}

const readCpuTimes = (cpus: readonly os.CpuInfo[]): CpuTimes =>
    cpus.reduce(
        (sum, cpu) => {
            const { idle, irq, nice, sys, user } = cpu.times;
            const total = idle + irq + nice + sys + user;
            return { busy: sum.busy + total - idle, total: sum.total + total };
        },
        { busy: 0, total: 0 },
    );

/**
 * Whole-machine CPU busy share between two reads of `os.cpus()`, 0–100 across all cores. The kernel counters are
 * cumulative since boot, so a percentage needs a previous read; the meter keeps one and reports `undefined` until it
 * has it. T3 Code derives host CPU the same way.
 */
export class CpuUsageMeter {
    private previous?: CpuTimes;

    constructor(private readonly readCpus: () => readonly os.CpuInfo[] = os.cpus) {}

    /**
     * Busy share since the previous call, or `undefined` on the first call or when no time has elapsed.
     */
    sample(): number | undefined {
        const current = readCpuTimes(this.readCpus());
        const { previous } = this;
        this.previous = current;
        if (!previous) return;
        const total = current.total - previous.total;
        if (total <= 0) return;
        const busy = Math.min(Math.max(current.busy - previous.busy, 0), total);
        return Math.round((busy / total) * 1000) / 10;
    }
}
