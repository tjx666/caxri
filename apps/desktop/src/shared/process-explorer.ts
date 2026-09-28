import type { RendererErrorKind, ThemeTokens } from '@caxri/protocol';
import { terminalProcessEntrySchema } from '@caxri/protocol';
import { z } from 'zod';

/**
 * What a process is to Caxri. Everything Main or Server Core owns by role gets a named kind; anything else (a shell, an
 * Agent CLI, a `git` child) is a plain `process` named after its executable.
 */
const processExplorerKindSchema = z.enum(['main', 'window', 'gpu', 'helper', 'service', 'process']);

const processExplorerEntrySchema = z.object({
    pid: z.number().int().positive(),
    parentPid: z.number().int().nonnegative(),
    /**
     * Short display name: a role label for Caxri's own processes, the executable (plus script for an interpreter) for
     * everything else.
     */
    name: z.string().min(1).max(4_096),
    /**
     * The redacted full command line, shown on hover and matched by the filter. Absent for Caxri's own processes, whose
     * command lines are artifact paths that say nothing the role label does not.
     */
    command: z.string().max(4_096).optional(),
    kind: processExplorerKindSchema,
    cpuPercent: z.number().nonnegative(),
    memoryMb: z.number().nonnegative(),
});

export const processExplorerSnapshotSchema = z.object({
    processes: z.array(processExplorerEntrySchema).max(2_048),
    /**
     * Running Terminals and the PTY root PID each owns, used to group processes by Session. Empty when Server Core is
     * unavailable; the processes then list under Caxri's own tree.
     */
    terminals: z.array(terminalProcessEntrySchema).max(1_024),
    systemMemoryMb: z.number().nonnegative(),
    sampledAt: z.number(),
});

export type ProcessExplorerKind = z.infer<typeof processExplorerKindSchema>;
export type ProcessExplorerEntry = z.infer<typeof processExplorerEntrySchema>;
export type ProcessExplorerSnapshot = z.infer<typeof processExplorerSnapshotSchema>;

/**
 * Narrow bridge exposed only to the dedicated Process Explorer renderer.
 */
export interface ProcessExplorerBridge {
    /**
     * Reports only a fault class; private exception values never cross the preload boundary.
     */
    reportError(kind: RendererErrorKind): void;
    snapshot(): Promise<ProcessExplorerSnapshot>;
    /**
     * Suspends one running Terminal (its whole process tree exits; the Session and Agent conversation survive).
     */
    stopTerminal(terminalId: string): Promise<{ suspended: boolean }>;
    theme(): Promise<ThemeTokens>;
}
