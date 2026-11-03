import type { AgentDelegationAnswer, AgentDelegationReceipt } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { isNewlyCompleted, recordDelegationResult } from '../session-result';

const receipt = (
    status: AgentDelegationReceipt['status'],
    overrides: Partial<AgentDelegationReceipt> = {},
): AgentDelegationReceipt => ({
    delegationId: 'task',
    projectId: 'project',
    sessionId: 'session',
    provider: 'claude',
    status,
    revision: 1,
    createdAt: 1,
    updatedAt: 10,
    ...overrides,
});
const answer = (text: string, messageId = 'message'): AgentDelegationAnswer => ({
    text,
    messageId,
    source: 'transcript',
    truncated: false,
    byteLength: text.length,
});

describe('isNewlyCompleted', () => {
    it('is true when a save moves the task into completed with an answer', () => {
        const saved = { receipt: receipt('completed'), answer: answer('Done.') };

        expect(isNewlyCompleted(saved, undefined)).toBe(true);
        expect(isNewlyCompleted(saved, { receipt: receipt('collecting') })).toBe(true);
    });

    it('is true again when a completed task completes with another answer', () => {
        const saved = { receipt: receipt('completed'), answer: answer('Again.', 'next') };

        expect(
            isNewlyCompleted(saved, { receipt: receipt('completed'), answer: answer('Done.') }),
        ).toBe(true);
    });

    it('is false for a save that leaves a completed task as it was', () => {
        const saved = { receipt: receipt('completed'), answer: answer('Done.') };

        expect(isNewlyCompleted(saved, saved)).toBe(false);
    });

    it('is false for a task that has not completed or has no answer', () => {
        expect(
            isNewlyCompleted({ receipt: receipt('failed'), answer: answer('x') }, undefined),
        ).toBe(false);
        expect(isNewlyCompleted({ receipt: receipt('completed') }, undefined)).toBe(false);
    });
});

describe('recordDelegationResult', () => {
    const database = (createdByRelation?: string) => {
        const saveResult = vi.fn();
        const deleteResult = vi.fn();
        return {
            saveResult,
            deleteResult,
            database: {
                getSession: () => ({ createdByRelation }),
                createdSessions: { saveResult, deleteResult },
            } as unknown as Parameters<typeof recordDelegationResult>[0],
        };
    };

    it.each(['delegated', 'consult'])('stores the summary for a %s Session', (relation) => {
        const { database: database_, saveResult } = database(relation);

        recordDelegationResult(database_, {
            receipt: receipt('completed', { settledAt: 9 }),
            answer: answer('Looked.\nSummary: Fine.'),
        });

        expect(saveResult).toHaveBeenCalledWith({
            sessionId: 'session',
            delegationId: 'task',
            summary: 'Fine.',
            source: 'authored',
            completedAt: 9,
        });
    });

    it('dates the result by the last update when the task carries no settle time', () => {
        const { database: database_, saveResult } = database('delegated');

        recordDelegationResult(database_, {
            receipt: receipt('completed'),
            answer: answer('Fine.'),
        });

        expect(saveResult).toHaveBeenCalledWith(expect.objectContaining({ completedAt: 10 }));
    });

    it.each(['handoff', undefined])('stores nothing for a Session with relation %s', (relation) => {
        const { database: database_, saveResult, deleteResult } = database(relation);

        recordDelegationResult(database_, {
            receipt: receipt('completed'),
            answer: answer('Fine.'),
        });

        expect(saveResult).not.toHaveBeenCalled();
        expect(deleteResult).not.toHaveBeenCalled();
    });

    it('removes the earlier result for an answer with no text to summarize', () => {
        const { database: database_, saveResult, deleteResult } = database('delegated');

        recordDelegationResult(database_, {
            receipt: receipt('completed'),
            answer: answer('   \n'),
        });

        expect(saveResult).not.toHaveBeenCalled();
        expect(deleteResult).toHaveBeenCalledWith('session');
    });
});
