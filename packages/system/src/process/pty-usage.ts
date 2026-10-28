import { readdir, readFile, readlink } from 'node:fs/promises';
import process from 'node:process';

import { execFileAsync } from '../filesystem/exec.js';
import { safeProcessEnvironment } from './environment.js';

const PTY_QUERY_TIMEOUT_MS = 3_000;
const MAX_PTY_QUERY_BYTES = 1024 * 1024;
/**
 * Upper bound on `/proc/<pid>/fd` entries read per process on Linux, so one process holding thousands of descriptors
 * cannot stall a sample.
 */
const MAX_LINUX_FDS_PER_PROCESS = 4_096;

/**
 * One process holding PTY master descriptors. Each open master is one PTY slot.
 */
export interface PtyHolder {
    pid: number;
    count: number;
}

/**
 * The machine's PTY slots: the kernel limit, how many are open right now, and which processes hold them. Only processes
 * this user may inspect are listed, so `holders` can sum to less than `inUse` on Linux, where `inUse` comes from
 * `/dev/pts` and covers every user. On macOS `inUse` is the holder sum, a lower bound that misses other users'
 * masters.
 */
export interface PtyUsage {
    limit: number;
    inUse: number;
    holders: PtyHolder[];
}

/**
 * Parses `lsof -F pf /dev/ptmx`: a `p<pid>` line starts each process, then one `f<fd>` line per open master.
 */
export function parseLsofPtyHolders(output: string): PtyHolder[] {
    const counts = new Map<number, number>();
    let pid: number | undefined;
    for (const line of output.split('\n')) {
        if (line.startsWith('p')) {
            const parsed = Number(line.slice(1));
            pid = parsed > 0 && Number.isSafeInteger(parsed) ? parsed : undefined;
        } else if (pid !== undefined && line.startsWith('f')) {
            counts.set(pid, (counts.get(pid) ?? 0) + 1);
        }
    }
    return counts
        .entries()
        .map(([holderPid, count]) => ({ pid: holderPid, count }))
        .toArray();
}

function positiveInteger(text: string): number | undefined {
    const value = Number(text.trim());
    return value > 0 && Number.isSafeInteger(value) ? value : undefined;
}

/**
 * `lsof` exits 1 both when nothing holds the file and when a listed process exited mid-scan; either way stdout already
 * carries every process it could read.
 */
function lsofStdout(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null || !('stdout' in error)) return;
    const { code, stdout } = error as { code?: unknown; stdout?: unknown };
    return code === 1 && typeof stdout === 'string' ? stdout : undefined;
}

const LSOF_PTY_HOLDER_ARGUMENTS = ['-n', '-P', '-F', 'pf', '/dev/ptmx'];
const SYSCTL_PTY_LIMIT_ARGUMENTS = ['-n', 'kern.tty.ptmx_max'];
const PTY_USAGE_SCAN_COMMANDS = [
    ['/usr/sbin/lsof', ...LSOF_PTY_HOLDER_ARGUMENTS].join(' '),
    ['/usr/sbin/sysctl', ...SYSCTL_PTY_LIMIT_ARGUMENTS].join(' '),
];

/**
 * How `ps` lists those queries once they exited but Server Core has not reaped them yet: the bare name in parentheses.
 */
const EXITED_PTY_USAGE_SCAN_COMMANDS = new Set(['(lsof)', '(sysctl)']);

/**
 * Whether a process command line is one of Caxri's own PTY usage queries, which process listings drop like the `ps`
 * that took them: each lives for a fraction of a second under Server Core and would otherwise flicker in the tree.
 */
export function isPtyUsageScanCommand(command: string): boolean {
    return (
        EXITED_PTY_USAGE_SCAN_COMMANDS.has(command) ||
        PTY_USAGE_SCAN_COMMANDS.some((scan) => command.startsWith(scan))
    );
}

async function macOSPtyLimit(): Promise<number | undefined> {
    const { stdout } = await execFileAsync('/usr/sbin/sysctl', SYSCTL_PTY_LIMIT_ARGUMENTS, {
        encoding: 'utf8',
        env: safeProcessEnvironment(),
        timeout: PTY_QUERY_TIMEOUT_MS,
    });
    return positiveInteger(stdout);
}

async function macOSPtyHolders(): Promise<PtyHolder[]> {
    let output: string;
    try {
        ({ stdout: output } = await execFileAsync('/usr/sbin/lsof', LSOF_PTY_HOLDER_ARGUMENTS, {
            encoding: 'utf8',
            env: safeProcessEnvironment(),
            maxBuffer: MAX_PTY_QUERY_BYTES,
            timeout: PTY_QUERY_TIMEOUT_MS,
        }));
    } catch (error) {
        const partial = lsofStdout(error);
        if (partial === undefined) throw error;
        output = partial;
    }
    return parseLsofPtyHolders(output);
}

async function linuxPtyHolders(): Promise<PtyHolder[]> {
    const pids = (await readdir('/proc')).flatMap((name) => positiveInteger(name) ?? []);
    const holders = await Promise.all(
        pids.map(async (pid): Promise<PtyHolder | undefined> => {
            let fds: string[];
            try {
                fds = (await readdir(`/proc/${pid}/fd`)).slice(0, MAX_LINUX_FDS_PER_PROCESS);
            } catch {
                // Another user's process, or one that exited since `/proc` was listed.
                return;
            }
            const targets = await Promise.all(
                fds.map(async (fd) => {
                    try {
                        return await readlink(`/proc/${pid}/fd/${fd}`);
                    } catch {
                        // The descriptor closed since the directory was listed.
                        return '';
                    }
                }),
            );
            const count = targets.filter(
                (target) => target === '/dev/ptmx' || target === '/dev/pts/ptmx',
            ).length;
            return count > 0 ? { pid, count } : undefined;
        }),
    );
    return holders.filter((holder) => holder !== undefined);
}

async function linuxPtyLimit(): Promise<number | undefined> {
    return positiveInteger(await readFile('/proc/sys/kernel/pty/max', 'utf8'));
}

/**
 * Counts open PTY slave nodes, which on Linux is exactly the number of PTYs in use.
 */
async function linuxPtyNodeCount(): Promise<number> {
    return (await readdir('/dev/pts')).filter((name) => /^\d+$/.test(name)).length;
}

/**
 * Counts `/dev/ttysNNN` nodes. macOS creates them on demand and keeps a closed one for reuse, so this is the high-water
 * mark since boot: never below the PTYs in use, often above. A reading under a threshold therefore proves usage is
 * under it without the much costlier `lsof` scan.
 */
async function macOSPtyNodeCount(): Promise<number> {
    return (await readdir('/dev')).filter((name) => /^ttys\d+$/.test(name)).length;
}

/**
 * A cheap number that is never below the PTYs in use, plus the limit, for a background check to decide whether the full
 * {@link samplePtyUsage} is worth running. `undefined` where PTY slots are not a bounded resource Caxri can read
 * (Windows ConPTY).
 */
export async function samplePtyUsageUpperBound(
    platform: NodeJS.Platform = process.platform,
): Promise<{ limit: number; upperBound: number } | undefined> {
    if (platform === 'darwin') {
        const [limit, upperBound] = await Promise.all([macOSPtyLimit(), macOSPtyNodeCount()]);
        return limit === undefined ? undefined : { limit, upperBound };
    }
    if (platform === 'linux') {
        const [limit, upperBound] = await Promise.all([linuxPtyLimit(), linuxPtyNodeCount()]);
        return limit === undefined ? undefined : { limit, upperBound };
    }
    return undefined;
}

/**
 * Reads the machine's PTY limit, the slots in use, and which processes hold them: `sysctl` and `lsof` on macOS, `/proc`
 * and `/dev/pts` on Linux. `undefined` on platforms without a readable PTY limit.
 */
export async function samplePtyUsage(
    platform: NodeJS.Platform = process.platform,
): Promise<PtyUsage | undefined> {
    if (platform === 'darwin') {
        const [limit, holders] = await Promise.all([macOSPtyLimit(), macOSPtyHolders()]);
        if (limit === undefined) return;
        return { limit, inUse: holders.reduce((sum, holder) => sum + holder.count, 0), holders };
    }
    if (platform === 'linux') {
        const [limit, inUse, holders] = await Promise.all([
            linuxPtyLimit(),
            linuxPtyNodeCount(),
            linuxPtyHolders(),
        ]);
        if (limit === undefined) return;
        return { limit, inUse, holders };
    }
    return undefined;
}

/**
 * The messages node-pty throws when the kernel refuses a new PTY (`forkpty`/`openpty`/`posix_openpt`). They are also
 * thrown for an unrelated `fork` failure, so a caller must confirm exhaustion with a usage sample before blaming it.
 */
export function isPtyAllocationError(message: string): boolean {
    return /forkpty\(3\) failed|openpty\(3\) failed|posix_openpt/i.test(message);
}
