import type { CaxriDatabase, StoredAgentDelegation } from '../db';
import { shouldReportDelegationResult } from './feed';

/**
 * The closing instruction every task of a Session that reports back carries, so the delegated Agent ends its answer
 * with the line `delegationResultSummary` reads. The instruction is fixed text, never the caller's.
 */
export const DELEGATION_SUMMARY_INSTRUCTION =
    'When you finish, end your final answer with one line: `Summary: <one sentence, at most 200 characters, on what you did or found>`.';

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
    record: Pick<StoredAgentDelegation, 'frozenInstructions' | 'input'>,
): string {
    return [
        record.frozenInstructions,
        record.input.prompt,
        shouldReportDelegationResult(database, record.input.sessionId)
            ? DELEGATION_SUMMARY_INSTRUCTION
            : undefined,
    ]
        .filter(Boolean)
        .join('\n\n');
}
