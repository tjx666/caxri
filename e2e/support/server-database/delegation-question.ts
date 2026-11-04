import { join } from 'node:path';

import type {
    DelegationQuestionAnsweredBy,
    DelegationQuestionCancelReason,
    DelegationQuestionEscalationReason,
    DelegationQuestionState,
} from '@caxri/protocol';

import { CaxriDatabase } from '../../../apps/server/src/domains/db';

interface Input {
    /**
     * `read` returns the stored question with `questionId`; `escalate` marks the child's open question as the user's to
     * answer (the 600 s grace elapsing is not worth waiting for); `open` returns the ID of the child's open question.
     */
    action: 'escalate' | 'open' | 'read';
    /**
     * The profile directory that holds `caxri.db`. The app keeps running on it.
     */
    userData: string;
    /**
     * The delegated child Session whose question is escalated or looked up.
     */
    sessionId?: string;
    questionId?: string;
}

/**
 * The stored shape the specs assert on. The text of the question is left out; the answer is kept so a spec can prove
 * who wrote it.
 */
export interface StoredQuestionRead {
    answerText?: string;
    answeredBy?: DelegationQuestionAnsweredBy;
    cancelReason?: DelegationQuestionCancelReason;
    escalationReason?: DelegationQuestionEscalationReason;
    isEscalated: boolean;
    state: DelegationQuestionState;
}

/**
 * Reads or escalates the questions of a delegated child straight in the Server database, which the running app reads on
 * every request. Only the escalation is a write, and it is the one a spec cannot wait out.
 */
export function run(input: Input): StoredQuestionRead | string | null {
    const database = new CaxriDatabase(join(input.userData, 'caxri.db'));
    try {
        const { questions } = database.agentDelegations;
        if (input.action === 'read') {
            const row = questions.get(input.questionId ?? '');
            if (!row) return null;
            return {
                ...(row.answerText !== undefined && { answerText: row.answerText }),
                ...(row.answeredBy !== undefined && { answeredBy: row.answeredBy }),
                ...(row.cancelReason !== undefined && { cancelReason: row.cancelReason }),
                ...(row.escalationReason !== undefined && {
                    escalationReason: row.escalationReason,
                }),
                isEscalated: row.escalatedAt !== undefined,
                state: row.state,
            };
        }
        const record = database.agentDelegations
            .all()
            .find((entry) => entry.receipt.sessionId === input.sessionId);
        if (!record) throw new Error('No delegation record for the child Session');
        const open = questions.openForDelegation(record.receipt.delegationId);
        if (!open) return null;
        if (input.action === 'open') return open.id;
        if (!questions.markEscalated(open.id, 'grace_elapsed', Date.now()))
            throw new Error('The question was not open');
        return open.id;
    } finally {
        database.close();
    }
}
