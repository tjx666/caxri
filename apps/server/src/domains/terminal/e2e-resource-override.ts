import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { identifierSchema } from '@caxri/protocol';
import { z } from 'zod';

const E2E_TERMINAL_RESOURCE_OVERRIDE_FILE_ENVIRONMENT_KEY =
    'CAXRI_E2E_TERMINAL_RESOURCE_OVERRIDE_FILE';

/**
 * Sample cadence while the seam is active. Production samples every 10 s and alerts after two consecutive high samples;
 * the Electron workflow proves the same raise/clear wiring in seconds instead of half a minute.
 */
const E2E_TERMINAL_RESOURCE_SAMPLE_INTERVAL_MS = 1_000;

const readingOverrideSchema = z
    .object({
        cpuPercent: z.number().nonnegative().optional(),
        memoryMb: z.number().nonnegative().optional(),
    })
    .strict();

const overrideFileSchema = z.record(identifierSchema, readingOverrideSchema);

export type TerminalResourceReadingOverride = z.infer<typeof readingOverrideSchema>;

export interface E2ETerminalResourceOverride {
    intervalMs: number;
    /**
     * The injected reading for one Terminal, or `undefined` to keep the real `ps` reading.
     */
    read: (terminalId: string) => Promise<TerminalResourceReadingOverride | undefined>;
}

/**
 * Replaces the measured CPU and memory of a Terminal's process tree with an injected value, keeping every other field
 * (the real process count) intact. A missing tree stays missing: the seam never invents a process.
 */
export function applyTerminalResourceOverride<
    Usage extends { cpuPercent: number; memoryMb: number },
>(usage: Usage | null, override: TerminalResourceReadingOverride | undefined): Usage | null {
    if (!usage || !override) return usage;
    return {
        ...usage,
        ...(override.cpuPercent !== undefined && { cpuPercent: override.cpuPercent }),
        ...(override.memoryMb !== undefined && { memoryMb: override.memoryMb }),
    };
}

/**
 * Resolves the E2E-only Terminal resource injection seam: a JSON file mapping Terminal IDs to the CPU and memory
 * reading Server Core should report for them, re-read on every sample so a spec can drive a Terminal above and back
 * below the shared resource-alert thresholds without burning real CPU or gigabytes of memory on the shared runner. Both
 * readers of a Terminal's usage honor it (the `terminal.resources` status bar query and the resource-alert monitor), so
 * the chip and the alert toast stay driven by one value, exactly as in production.
 *
 * Production launches ignore the variable even when it is present in the ambient environment.
 */
export function resolveE2ETerminalResourceOverride(
    environment: NodeJS.ProcessEnv,
): E2ETerminalResourceOverride | undefined {
    if (environment.CAXRI_E2E !== '1') return;
    const path = environment[E2E_TERMINAL_RESOURCE_OVERRIDE_FILE_ENVIRONMENT_KEY];
    if (path === undefined) return;
    if (!isAbsolute(path))
        throw new Error(
            `${E2E_TERMINAL_RESOURCE_OVERRIDE_FILE_ENVIRONMENT_KEY} must be an absolute path`,
        );
    return {
        intervalMs: E2E_TERMINAL_RESOURCE_SAMPLE_INTERVAL_MS,
        read: async (terminalId) => (await readOverrideFile(path))[terminalId],
    };
}

async function readOverrideFile(
    path: string,
): Promise<Record<string, TerminalResourceReadingOverride>> {
    let source: string;
    try {
        source = await readFile(path, 'utf8');
    } catch (error) {
        // Absent until the spec first injects a reading.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
        throw error;
    }
    return overrideFileSchema.parse(JSON.parse(source));
}
