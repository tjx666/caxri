import type { AgentDelegationReceipt } from '@caxri/protocol';

import type { CaxriDatabase, StoredAgentDelegation } from '../db';
import { shouldReportDelegationResult } from './feed';

/**
 * The closing instruction every task of a Session that reports back carries, so the delegated Agent ends its answer
 * with the line `delegationResultSummary` reads. The instruction is fixed text, never the caller's.
 */
export const DELEGATION_SUMMARY_INSTRUCTION =
    'When you finish, end your final answer with one line: `Summary: <one sentence, at most 200 characters, on what you did or found>`.';

/**
 * Opens the task file of a retry started over in a new Session. Fixed text, never the caller's, and kept out of the
 * stored prompt so it does not count against the 16 KiB task limit or repeat on a later retry.
 */
export const RETRY_PREFACE =
    'A previous attempt at this task failed before finishing. Redo it from the start.';

/**
 * Opens the task file of a retry that continues the failed task's own conversation.
 */
export const RETRY_RESUME_PREFACE =
    'The previous attempt at this task stopped before finishing. Continue it from where it stopped.';

/**
 * The task file's body: the frozen instructions, the caller's prompt, and, when the target Session reports a result
 * ({@link shouldReportDelegationResult}: another Session delegated to it or consulted it),
 * {@link DELEGATION_SUMMARY_INSTRUCTION}. The Session already exists when its first task is created, so a new Session's
 * first task, a follow-up, and a resume all follow the same condition as the stored result; a hand-off, an ordinary
 * Session, and Caxri Bot's tasks, whose result is never stored, carry no instruction. Only the body changes; the
 * pointer the Agent receives and its prompt digest are computed from the file path and stay as they were.
 */
export function delegationTaskBody(
    database: Pick<CaxriDatabase, 'getSession'>,
    record: Pick<StoredAgentDelegation, 'frozenInstructions' | 'input'> & {
        receipt?: Pick<AgentDelegationReceipt, 'resumeFrom' | 'retryOf'>;
    },
): string {
    const { receipt } = record;
    return [
        receipt?.retryOf ? (receipt.resumeFrom ? RETRY_RESUME_PREFACE : RETRY_PREFACE) : undefined,
        record.frozenInstructions,
        record.input.prompt,
        shouldReportDelegationResult(database, record.input.sessionId)
            ? DELEGATION_SUMMARY_INSTRUCTION
            : undefined,
    ]
        .filter(Boolean)
        .join('\n\n');
}
