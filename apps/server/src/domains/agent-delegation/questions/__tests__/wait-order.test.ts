import type { AgentDelegationReceipt } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { pollDelegations } from '../../wait';

const receipt = (
    delegationId: string,
    status: AgentDelegationReceipt['status'],
): AgentDelegationReceipt => ({
    delegationId,
    projectId: 'project-1',
    sessionId: 'session-1',
    provider: 'claude',
    status,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
});

/**
 * Per task, a settled task ranks before its question, and a question before a blocked task.
 */
describe('the order of delegation wait outcomes', () => {
    const poll = (reads: Record<string, ReturnType<typeof receipt> & { questionId?: string }>) =>
        pollDelegations(
            ['a', 'b'],
            (id) =>
                Promise.resolve({
                    receipt: reads[id],
                    ...(reads[id].questionId && { questionId: reads[id].questionId }),
                }),
            () => false,
            0,
        );

    it('returns a question before a blocked state of the same task', async () => {
        const blocked = Object.assign(receipt('a', 'blocked'), { questionId: 'question-1' });

        await expect(poll({ a: blocked, b: receipt('b', 'running') })).resolves.toMatchObject({
            outcome: 'question',
            questionId: 'question-1',
        });
    });

    it('returns a settled task ahead of a later task with a question', async () => {
        const asking = Object.assign(receipt('b', 'running'), { questionId: 'question-1' });

        const result = await poll({ a: receipt('a', 'completed'), b: asking });

        expect(result).toMatchObject({ outcome: 'settled' });
        expect(result).not.toHaveProperty('questionId');
    });

    it('returns a question ahead of a later blocked task, and times out with neither', async () => {
        const asking = Object.assign(receipt('a', 'running'), { questionId: 'question-1' });

        await expect(poll({ a: asking, b: receipt('b', 'blocked') })).resolves.toMatchObject({
            outcome: 'question',
        });
        await expect(
            poll({ a: receipt('a', 'running'), b: receipt('b', 'running') }),
        ).resolves.toMatchObject({ outcome: 'timeout' });
    });
});
