import type {
    AgentDelegationSession,
    DelegationQuestionAnswerResult,
    DelegationQuestionDetail,
} from '@caxri/protocol';
import { MAX_ANSWER_TEXT_CHARS } from '@caxri/protocol';

import type { TranslationKey } from '../../i18n';

/**
 * How the question card of one delegated Session shows:
 *
 * - `hidden`: no open question, or the user already took the Session over (the Server cancels the question then).
 * - `offer`: the delegating Agent has the question inside its grace period; the user may answer first ("I will answer").
 * - `escalated`: the question became the user's to answer; the answer field is open from the start.
 */
export type DelegationQuestionMode = 'escalated' | 'hidden' | 'offer';

export function delegationQuestionMode(
    task: Partial<Pick<AgentDelegationSession, 'takenOverAt' | 'waitingOn'>> | undefined,
): DelegationQuestionMode {
    if (!task || task.takenOverAt !== undefined) return 'hidden';
    if (task.waitingOn === 'user') return 'escalated';
    return task.waitingOn === 'parent' ? 'offer' : 'hidden';
}

/**
 * The inline note for an answer that was not delivered because the question closed first, or `undefined` when the
 * answer went through (or nothing was sent yet).
 */
export function delegationQuestionNoticeKey(
    outcome: DelegationQuestionAnswerResult['outcome'] | undefined,
):
    | Extract<
          TranslationKey,
          'delegation.question.alreadyAnswered' | 'delegation.question.cancelled'
      >
    | undefined {
    if (outcome === 'already_answered') return 'delegation.question.alreadyAnswered';
    if (outcome === 'cancelled') return 'delegation.question.cancelled';
    return undefined;
}

/**
 * Whether the draft can be sent: not blank once trimmed (the Server trims too) and within the answer bound.
 */
export function canSendDelegationAnswer(draft: string): boolean {
    return draft.trim().length > 0 && draft.length <= MAX_ANSWER_TEXT_CHARS;
}

/**
 * The answer choices the question offers, or none. A choice only fills the draft; the user still sends it.
 */
export function delegationQuestionOptions(
    question: Pick<DelegationQuestionDetail, 'options'> | undefined,
): readonly string[] {
    return question?.options ?? [];
}
