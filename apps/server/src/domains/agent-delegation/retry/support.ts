import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';

import type {
    AgentDelegationReceipt,
    AgentProvider,
    DelegationRetryUnavailableReason,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { CaxriDatabase, StoredAgentDelegation } from '../../db';
import type { DelegationResumeRejection } from '../rejection';
import type { DelegationWorktree } from '../service-options';

export type Reason = DelegationRetryUnavailableReason;

/**
 * What a retry adds to ordinary admission (`createInSession`): the link back, the failed task's provider to hold to,
 * the tree position to keep, and the recheck of its caller.
 */
export interface RetryAdmission {
    retryOf: string;
    /**
     * The Agent the retry runs on: the failed task's own unless the claim names a switch target. A current setting that
     * now resolves to any other provider is refused.
     */
    provider: AgentProvider;
    inherited: Pick<AgentDelegationReceipt, 'depth' | 'parentDelegationId'> & {
        callerTurnId?: string;
        callerLaunchId?: string;
    };
    /**
     * Throws unless the delegating Agent is still the live generation that can read the new task. Called after every
     * await that precedes an irreversible step.
     */
    guard(): void;
}

/**
 * A retry refused for a reason a Client words itself; see `delegationRetryUnavailableReasonSchema`.
 */
export class RetryRefused extends CaxriError {
    constructor(readonly reason: Reason) {
        super('CONFLICT', `Delegated task cannot be retried: ${reason}`, { reason });
    }
}

/**
 * Resume refusals as the reason a Client shows. The wording differs from the failure a refused follow-up records, so
 * this is its own table; a task with no conversation to resume reads as `no_provider_session`.
 */
export const RESUME_REASONS = {
    no_terminal: 'no_provider_session',
    no_provider_session: 'no_provider_session',
    provider_session_replaced: 'session_changed',
    parent_chained: 'target_busy',
    terminal_busy: 'target_busy',
    target_lost: 'target_changed',
    launch_replaced: 'target_changed',
    human_intervened: 'human_input',
    no_input_epoch: 'human_input',
    input_epoch_moved: 'human_input',
    parent_human_intervened: 'human_input',
    resume_unsupported: 'resume_unsupported',
} as const satisfies Record<DelegationResumeRejection, Reason>;

/**
 * The new task's ID, derived from the failed task's alone. It must not depend on the mode, so two buttons racing for
 * one failed task name the same ID, and a scheduled retry that was cut off by a crash names the task it may already
 * have stored. UUID-shaped because task IDs name private directories (`prepareDelegationLaunch`).
 */
export function retryDelegationId(failedId: string): string {
    const hex = createHash('sha256').update(`retry\0${failedId}`).digest('hex');
    return [
        hex.slice(0, 8),
        hex.slice(8, 12),
        hex.slice(12, 16),
        hex.slice(16, 20),
        hex.slice(20, 32),
    ].join('-');
}

/**
 * A retry runs on exactly its claimed Agent. A fresh retry of a preset resolves its launch from the current settings,
 * which can now name another provider for the same preset.
 */
export function assertRetryProvider(
    retry: RetryAdmission | undefined,
    selection: { provider: AgentProvider },
): void {
    if (retry && retry.provider !== selection.provider) throw new RetryRefused('not_retryable');
}

export interface VerifiedWorktree {
    /**
     * The linked worktree to bind, absent when the failed Session ran in its Project's own root.
     */
    worktree?: DelegationWorktree;
    /**
     * The Session's binding as read before the filesystem check, to compare with the binding afterwards.
     */
    binding: string;
}

/**
 * The linked worktree a fresh retry must reuse, proven to still be the directory it was bound to. Never falls back to
 * the Project root, which would be the wrong working directory. Asynchronous: the caller rechecks everything
 * synchronously afterwards.
 */
export async function verifyRetryWorktree(
    database: Pick<CaxriDatabase, 'getProject' | 'getSessionWorkbenchBinding'>,
    failed: StoredAgentDelegation,
): Promise<VerifiedWorktree> {
    const binding = database.getSessionWorkbenchBinding(failed.receipt.sessionId);
    const key = JSON.stringify(binding);
    if (!binding || binding.workbenchRootProjectId === binding.projectId) return { binding: key };
    const project = database.getProject(binding.workbenchRootProjectId);
    if (!project || !binding.rootInode) throw new RetryRefused('worktree_gone');
    try {
        const stats = await lstat(project.rootPath, { bigint: true });
        if (
            stats.isSymbolicLink() ||
            !stats.isDirectory() ||
            stats.ino.toString() !== binding.rootInode
        )
            throw new RetryRefused('worktree_gone');
        return {
            binding: key,
            worktree: {
                projectId: binding.workbenchRootProjectId,
                identity: { device: stats.dev.toString(), inode: stats.ino.toString() },
            },
        };
    } catch {
        throw new RetryRefused('worktree_gone');
    }
}
