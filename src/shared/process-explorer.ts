import { z } from 'zod';

import type { ThemeTokens } from './types';

const processExplorerEntrySchema = z.object({
    pid: z.number().int().positive(),
    parentPid: z.number().int().nonnegative(),
    name: z.string().min(1).max(4_096),
    cpuPercent: z.number().nonnegative(),
    memoryMb: z.number().nonnegative(),
});

export const processExplorerSnapshotSchema = z.object({
    processes: z.array(processExplorerEntrySchema).max(2_048),
    sampledAt: z.number(),
});

export type ProcessExplorerEntry = z.infer<typeof processExplorerEntrySchema>;
export type ProcessExplorerSnapshot = z.infer<typeof processExplorerSnapshotSchema>;

/** Narrow bridge exposed only to the dedicated Process Explorer renderer. */
export interface ProcessExplorerBridge {
    snapshot(): Promise<ProcessExplorerSnapshot>;
    theme(): Promise<ThemeTokens>;
}
