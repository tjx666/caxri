import { z } from 'zod';

/**
 * Shared rollup state for anything that reports a check-like outcome: Project Status checks and deployments, and a
 * Session's pull request CI summary.
 */
export const projectStatusStateSchema = z.enum([
    'success',
    'failure',
    'pending',
    'neutral',
    'unknown',
]);
