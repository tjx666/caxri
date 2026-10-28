import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { z } from 'zod';

const E2E_PTY_USAGE_OVERRIDE_FILE_ENVIRONMENT_KEY = 'CAXRI_E2E_PTY_USAGE_OVERRIDE_FILE';

/**
 * Sample cadence while the seam is active, so an Electron workflow sees the alert within seconds instead of the
 * production half minute.
 */
const E2E_PTY_USAGE_SAMPLE_INTERVAL_MS = 1_000;

const ptyUsageReadingOverrideSchema = z
    .object({
        inUse: z.number().int().nonnegative(),
        limit: z.number().int().positive(),
    })
    .strict();

type PtyUsageReadingOverride = z.infer<typeof ptyUsageReadingOverrideSchema>;

export interface E2EPtyUsageOverride {
    intervalMs: number;
    /**
     * The injected machine reading, or `undefined` to keep the real one.
     */
    read: () => Promise<PtyUsageReadingOverride | undefined>;
}

/**
 * Resolves the E2E-only PTY usage injection seam: a JSON file holding the `inUse` and `limit` Server Core should
 * report, re-read on every sample, so a spec can drive the machine near its PTY limit without exhausting the runner's
 * real PTYs (which would break every other terminal on it). The real holders stay in the reading.
 *
 * Production launches ignore the variable even when it is present in the ambient environment.
 */
export function resolveE2EPtyUsageOverride(
    environment: NodeJS.ProcessEnv,
): E2EPtyUsageOverride | undefined {
    if (environment.CAXRI_E2E !== '1') return;
    const path = environment[E2E_PTY_USAGE_OVERRIDE_FILE_ENVIRONMENT_KEY];
    if (path === undefined) return;
    if (!isAbsolute(path))
        throw new Error(`${E2E_PTY_USAGE_OVERRIDE_FILE_ENVIRONMENT_KEY} must be an absolute path`);
    return {
        intervalMs: E2E_PTY_USAGE_SAMPLE_INTERVAL_MS,
        read: async () => {
            let source: string;
            try {
                source = await readFile(path, 'utf8');
            } catch (error) {
                // Absent until the spec first injects a reading.
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
                throw error;
            }
            return ptyUsageReadingOverrideSchema.parse(JSON.parse(source));
        },
    };
}
