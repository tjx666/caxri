import { execFileAsync } from '../../shared/node/exec';
import { safeProcessEnvironment } from '../../shared/node/process-environment';
import type { TerminalResourceUsage } from '../../shared/types';

const MAX_PROCESS_SNAPSHOT_BYTES = 4 * 1024 * 1024;

interface ProcessResourceEntry {
    pid: number;
    parentPid: number;
    rssKb: number;
}

export function parseProcessResourceEntries(output: string): ProcessResourceEntry[] {
    return output.split('\n').flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
        if (!match) return [];
        const [pid, parentPid, rssKb] = match.slice(1).map(Number);
        if (![pid, parentPid, rssKb].every(Number.isFinite) || pid <= 0 || rssKb < 0) return [];
        return [{ pid, parentPid, rssKb }];
    });
}

/**
 * Aggregates the PTY shell and all descendants while counting descendants only.
 */
export function aggregateTerminalResources(
    rootPid: number,
    entries: readonly ProcessResourceEntry[],
): TerminalResourceUsage | null {
    const byPid = new Map(entries.map((entry) => [entry.pid, entry]));
    if (!byPid.has(rootPid)) return null;
    const children = new Map<number, number[]>();
    for (const entry of entries) {
        const siblings = children.get(entry.parentPid) ?? [];
        siblings.push(entry.pid);
        children.set(entry.parentPid, siblings);
    }
    const processIds = new Set<number>();
    const pending = [rootPid];
    while (pending.length > 0) {
        const pid = pending.pop()!;
        if (processIds.has(pid)) continue;
        processIds.add(pid);
        pending.push(...(children.get(pid) ?? []));
    }
    const rssKb = [...processIds].reduce((total, pid) => total + (byPid.get(pid)?.rssKb ?? 0), 0);
    return {
        memoryMb: Math.round((rssKb / 1024) * 10) / 10,
        childProcessCount: Math.max(0, processIds.size - 1),
    };
}

export async function sampleTerminalResources(
    rootPid: number,
): Promise<TerminalResourceUsage | null> {
    try {
        const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid=,rss='], {
            timeout: 2_000,
            maxBuffer: MAX_PROCESS_SNAPSHOT_BYTES,
            env: safeProcessEnvironment(),
        });
        return aggregateTerminalResources(rootPid, parseProcessResourceEntries(stdout));
    } catch {
        /**
         * The PTY may exit between resolving its PID and sampling the process table.
         */
        return null;
    }
}
