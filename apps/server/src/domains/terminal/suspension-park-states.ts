import type { TerminalRecord } from '@caxri/protocol';

import type { TerminalLifecycleCause } from './manager-types';
import type { TerminalSuspensionReason } from './suspension-policy';

/**
 * What each `TerminalSuspensionService` park writes, and which durable states a later launch resumes from.
 */

export type ParkReason =
    TerminalSuspensionReason | 'archived' | 'detached' | 'requested' | 'terminated';

/**
 * Why a resumed Terminal was parked: the park reason this process recorded, or `beforeRestart` for a Terminal an
 * earlier Server Core left `suspended` or `detached`, whose reason and park time died with that process.
 */
export type ResumeReason = ParkReason | 'beforeRestart';

/**
 * The durable states a later Agent launch resumes from; `stopped` is final and never restored.
 */
export const PARKED_STATES: ReadonlySet<TerminalRecord['lastProcessState']> = new Set([
    'detached',
    'suspended',
]);

/**
 * The durable state and lifecycle cause each park writes. Only a terminate is final: `stopped` is never restored, while
 * `suspended` resumes on selection and `detached` on `session.resume`.
 */
export const PARKED_AS: Record<
    ParkReason,
    { state: 'detached' | 'stopped' | 'suspended'; cause?: TerminalLifecycleCause }
> = {
    archived: { state: 'suspended', cause: 'sessionArchived' },
    detached: { state: 'detached' },
    idle: { state: 'suspended', cause: 'idleSuspended' },
    observation: { state: 'suspended', cause: 'observationExpired' },
    requested: { state: 'suspended' },
    terminated: { state: 'stopped', cause: 'userTerminated' },
    untouched: { state: 'suspended', cause: 'untouchedSuspended' },
};
