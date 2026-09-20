import { z } from 'zod';

/**
 * Why a bounded low-cost text generation could not run. Both values describe the Project sandbox boundary the provider
 * was given, never the provider's error text, so they are safe to persist and replay.
 *
 * Automatic Session naming is the only caller today. It lives here rather than beside that feature because the sandbox
 * it describes is owned by the shared low-cost generation path, not by naming.
 */
export const lowCostSandboxFailureReasonSchema = z.enum([
    'sandboxBoundaryConflict',
    'sandboxPathUnavailable',
]);

export type LowCostSandboxFailureReason = z.infer<typeof lowCostSandboxFailureReasonSchema>;
