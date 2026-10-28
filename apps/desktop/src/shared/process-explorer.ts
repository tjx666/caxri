import type { AppLocale, RendererErrorKind, ThemeTokens } from '@caxri/protocol';
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
    /**
     * PTY masters this process holds open, each one of the machine's limited PTY slots. Absent when it holds none or
     * the PTY reading was unavailable. Terminal Host holds the master of every running Terminal; those count on each
     * Terminal's row instead (one each), so Terminal Host keeps only masters no listed Terminal accounts for.
     */
    ptyCount: z.number().int().positive().optional(),
});

export const processExplorerSnapshotSchema = z.object({
    processes: z.array(processExplorerEntrySchema).max(2_048),
    /**
     * Running Terminals and the PTY root PID each owns, used to group processes by Session. Empty when Server Core is
     * unavailable; the processes then list under Caxri's own tree.
     */
    terminals: z.array(terminalProcessEntrySchema).max(1_024),
    systemMemoryMb: z.number().nonnegative(),
    /**
     * The machine's PTY slots in use and their limit; absent where the platform has no readable PTY limit or Server
     * Core could not read it.
     */
    pty: z
        .object({ inUse: z.number().int().nonnegative(), limit: z.number().int().positive() })
        .optional(),
    /**
     * Processes outside Caxri that hold PTYs, such as another terminal app, so a nearly full machine shows who else is
     * using the slots. Read-only: Process Explorer can stop only Caxri's own Terminals.
     */
    otherPtyHolders: z.array(processExplorerEntrySchema).max(1_024),
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
    /**
     * The `workbench.language` setting; `null` follows the system language. The window loads no Workbench snapshot, so
     * this is its only way to speak the language the other windows speak.
     */
    language(): Promise<AppLocale | null>;
    /**
     * Calls `listener` with the setting each time it may have changed while the window is open; returns the
     * unsubscribe.
     */
    onLanguageChanged(listener: (preference: AppLocale | null) => void): () => void;
}
