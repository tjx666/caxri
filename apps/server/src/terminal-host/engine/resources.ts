import type { TerminalResourceUsage } from '@caxri/protocol';
import type { ProcessTable } from '@caxri/system';
import { sampleProcessTable } from '@caxri/system';

/**
 * Aggregates the PTY shell and all descendants while counting descendants only.
 */
export function aggregateTerminalResources(
    rootPid: number,
    table: ProcessTable,
): TerminalResourceUsage | null {
    const usage = table.usage(rootPid);
    if (!usage) return null;
    return {
        cpuPercent: usage.cpuPercent,
        memoryMb: usage.memoryMb,
        childProcessCount: Math.max(0, usage.processCount - 1),
    };
}

export async function sampleTerminalResources(
    rootPid: number,
): Promise<TerminalResourceUsage | null> {
    try {
        return aggregateTerminalResources(rootPid, await sampleProcessTable());
    } catch {
        /**
         * The PTY may exit between resolving its PID and sampling the process table.
         */
        return null;
    }
}
