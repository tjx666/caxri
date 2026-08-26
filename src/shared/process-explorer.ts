import type { RendererErrorKind, ThemeTokens } from '@caxri/protocol';
import { z } from 'zod';

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

/**
 * Narrow bridge exposed only to the dedicated Process Explorer renderer.
 */
export interface ProcessExplorerBridge {
    /**
     * Reports only a fault class; private exception values never cross the preload boundary.
     */
    reportError(kind: RendererErrorKind): void;
    snapshot(): Promise<ProcessExplorerSnapshot>;
    theme(): Promise<ThemeTokens>;
}
