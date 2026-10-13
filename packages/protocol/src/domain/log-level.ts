import { z } from 'zod';

/**
 * Leaf module: every Server process resolves its log level at start, so this must not pull in the log query contract
 * that `business-contract.ts` builds on top of it; see `docs/server-footprint.md`.
 */
export const logLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);

export type LogLevel = z.infer<typeof logLevelSchema>;
