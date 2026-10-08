import { z } from 'zod';

/**
 * Shared rollup state for anything that reports a check-like outcome: Project Status checks and deployments, and a
 * Session's pull request CI summary.
 *
 * `queued` and `pending` are deliberately separate. A check waiting for a runner and a check that is actually executing
 * answer different questions (whether the work has started at all, and how long it has been going) and collapsing them
 * left a page of identical spinners that said nothing about which of twenty checks was moving. GitHub draws them apart
 * for the same reason.
 */
export const projectStatusStateSchema = z.enum([
    'success',
    'failure',
    'cancelled',
    'pending',
    'queued',
    'neutral',
    'unknown',
]);
