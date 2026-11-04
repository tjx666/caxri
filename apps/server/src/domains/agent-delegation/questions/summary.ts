import type { DelegationQuestionSummary, DelegationWaitingOn } from '@caxri/protocol';

import type { CaxriDatabase } from '../../db';

/**
 * What the Delegated Sessions feed shows of a delegation's open question: that it exists and who it waits on, never its
 * text.
 */
export interface DelegationQuestionState {
    question: DelegationQuestionSummary;
    waitingOn: DelegationWaitingOn;
}

/**
 * The open question of each named delegation, in one read; a delegation with none is absent. `waitingOn` is derived
 * here and never stored: the delegating Agent until the question escalates, then the user.
 */
export function questionSummaries(
    database: CaxriDatabase,
    delegationIds: readonly string[],
): Map<string, DelegationQuestionState> {
    const summaries = new Map<string, DelegationQuestionState>();
    for (const [delegationId, question] of database.agentDelegations.questions.openForDelegations(
        delegationIds,
    )) {
        const isEscalated = question.escalatedAt !== undefined;
        summaries.set(delegationId, {
            question: {
                questionId: question.id,
                askedAt: question.askedAt,
                escalated: isEscalated,
            },
            waitingOn: isEscalated ? 'user' : 'parent',
        });
    }
    return summaries;
}
