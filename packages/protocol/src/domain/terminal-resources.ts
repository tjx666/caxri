import { formatBytes } from '@caxri/utils';
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
 * Everything one Session is running right now, summed: each PTY Terminal's process tree and each live Chat provider's
 * process tree. CPU is summed `ps` `%cpu`, so it can exceed 100.
 */
export const sessionResourceUsageSchema = z.object({
    cpuPercent: z.number().nonnegative(),
    memoryMb: z.number().nonnegative(),
    processCount: z.number().int().nonnegative(),
});

export type SessionResourceUsage = z.infer<typeof sessionResourceUsageSchema>;

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

/**
 * The machine's PTY slots. Every Terminal, and every PTY an Agent opens for its own commands, takes one; once all are
 * taken no application on the machine can open another terminal. `holders` lists the processes this user may inspect,
 * with how many PTY masters each holds open.
 */
const ptyHolderSchema = z.object({
    pid: z.number().int().positive(),
    count: z.number().int().positive(),
});

export const ptyUsageSchema = z.object({
    limit: z.number().int().positive(),
    inUse: z.number().int().nonnegative(),
    holders: z.array(ptyHolderSchema).max(4_096),
});

export type PtyUsage = z.infer<typeof ptyUsageSchema>;

/**
 * Share of the PTY limit at which Caxri warns. macOS defaults to 511 slots, so this leaves about a hundred: enough for
 * the user to act before a new Terminal fails, high enough that ordinary heavy use never trips it.
 */
export const PTY_USAGE_ALERT_RATIO = 0.8;

export function isPtyUsageHigh(usage: { inUse: number; limit: number }): boolean {
    return usage.inUse >= Math.ceil(usage.limit * PTY_USAGE_ALERT_RATIO);
}

/**
 * `raised` when the machine's PTY use reaches {@link PTY_USAGE_ALERT_RATIO} of the limit, `cleared` once it falls back
 * below, so a client can retract a notice that stopped being true.
 */
export const terminalPtyAlertSchema = z.object({
    state: z.enum(['raised', 'cleared']),
    inUse: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
});

export type TerminalPtyAlert = z.infer<typeof terminalPtyAlertSchema>;

const BYTES_PER_MEBIBYTE = 1024 * 1024;

/**
 * Process readings arrive as `memoryMb` (`ps` RSS or Electron working set). Printing that verbatim (`2402.8 MB`) never
 * rolls over into GB, so every surface that shows one (the status bar chip, Process Explorer, the resource alert, the
 * phone's computer status) goes through the shared binary-unit `formatBytes` here instead of a one-off.
 */
export function formatMemoryMb(memoryMb: number): string {
    return formatBytes(Math.round(memoryMb * BYTES_PER_MEBIBYTE));
}

/**
 * `ps`-style CPU, where a busy multi-process tree exceeds 100%. One decimal while small enough for it to matter, whole
 * percent once it does not.
 */
export function formatCpuPercent(cpuPercent: number): string {
    return cpuPercent < 10 ? `${cpuPercent.toFixed(1)}%` : `${Math.round(cpuPercent)}%`;
}
