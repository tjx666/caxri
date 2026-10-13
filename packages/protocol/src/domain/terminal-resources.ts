import { z } from 'zod';

import { agentProviderSchema } from '../agent/agents.js';
import { identifierSchema } from './identifiers.js';
import { terminalKindSchema } from './terminal-record.js';

export const terminalResourceUsageSchema = z.object({
    memoryMb: z.number().nonnegative(),
    /**
     * Summed `ps` `%cpu` across the process tree, so a busy multi-process tree can exceed 100.
     */
    cpuPercent: z.number().nonnegative(),
    childProcessCount: z.number().int().nonnegative(),
});

export type TerminalResourceUsage = z.infer<typeof terminalResourceUsageSchema>;

/**
 * Where a Terminal's whole process tree (the PTY shell plus every descendant) counts as using too much. One pair of
 * numbers is shared by the Server Core monitor that raises the alert, the status bar chip that turns red, and Process
 * Explorer's row highlight, so the three surfaces can never disagree about whether the same Terminal is "high".
 *
 * A resident Agent CLI normally sits well under 1 GB and near-idle CPU; a runaway one observed in practice held several
 * gigabytes and 200–400% CPU for minutes. CPU is `ps`'s `%cpu`, which on macOS is already a decaying average over up to
 * a minute, so a short compile burst does not cross the line on its own.
 */
export const TERMINAL_RESOURCE_ALERT_THRESHOLDS = {
    cpuPercent: 300,
    memoryMb: 4_096,
} as const;

export function isTerminalResourceUsageHigh(usage: {
    cpuPercent: number;
    memoryMb: number;
}): boolean {
    return (
        usage.memoryMb >= TERMINAL_RESOURCE_ALERT_THRESHOLDS.memoryMb ||
        usage.cpuPercent >= TERMINAL_RESOURCE_ALERT_THRESHOLDS.cpuPercent
    );
}

/**
 * One running Terminal as a process inspector needs it: which PTY root PID belongs to which Session, and what to call
 * it. Deliberately metadata only: no cwd, no output, no transcript.
 */
export const terminalProcessEntrySchema = z.object({
    terminalId: identifierSchema,
    sessionId: identifierSchema,
    sessionTitle: z.string().max(512),
    kind: terminalKindSchema,
    provider: agentProviderSchema.optional(),
    title: z.string().max(512),
    processId: z.number().int().positive(),
});

export type TerminalProcessEntry = z.infer<typeof terminalProcessEntrySchema>;

/**
 * `raised` the first time a Terminal's tree stays above {@link TERMINAL_RESOURCE_ALERT_THRESHOLDS} across consecutive
 * samples, `cleared` once it falls back below them, so a client can retract a notice that stopped being true.
 */
export const terminalResourceAlertSchema = z.object({
    state: z.enum(['raised', 'cleared']),
    terminal: terminalProcessEntrySchema,
    cpuPercent: z.number().nonnegative(),
    memoryMb: z.number().nonnegative(),
    processCount: z.number().int().nonnegative(),
});

export type TerminalResourceAlert = z.infer<typeof terminalResourceAlertSchema>;
