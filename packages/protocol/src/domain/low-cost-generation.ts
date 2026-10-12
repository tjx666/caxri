import { z } from 'zod';

/**
 * Why a bounded low-cost text generation could not run. Every value describes the host sandbox the provider was given,
 * never the provider's error text, so they are safe to persist and replay. `sandboxUnavailable` means the host has no
 * supported sandbox at all (a Linux SSH Host without bubblewrap).
 *
 * Automatic Session naming is the only caller today. It lives here rather than beside that feature because the sandbox
 * it describes is owned by the shared low-cost generation path, not by naming.
 */
export const lowCostSandboxFailureReasonSchema = z.enum([
    'sandboxBoundaryConflict',
    'sandboxPathUnavailable',
    'sandboxUnavailable',
]);

export type LowCostSandboxFailureReason = z.infer<typeof lowCostSandboxFailureReasonSchema>;
