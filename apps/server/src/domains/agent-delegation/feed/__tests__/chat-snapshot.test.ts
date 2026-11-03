import type { AgentChatItem } from '@caxri/protocol';
import { MAX_DELEGATION_STEP_LENGTH } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { delegationChatStep, delegationUsageLimitResetsAt } from '../chat-snapshot';

const command = (
    id: string,
    turnId: string,
    text: string,
    status: 'completed' | 'running' = 'running',
): AgentChatItem => ({ id, turnId, type: 'command', command: text, status, output: '' });

const reasoning = (id: string, turnId: string, text: string): AgentChatItem => ({
    id,
    turnId,
    type: 'reasoning',
    text,
    streaming: true,
});

const message = (id: string, turnId: string): AgentChatItem => ({
    id,
    turnId,
    type: 'agentMessage',
    text: 'Working on it.',
    streaming: true,
});

describe('delegationChatStep', () => {
    it('names the running tool of the active turn the way the Chat row does', () => {
        const step = delegationChatStep({
            activeTurnId: 'turn',
            items: [command('a', 'turn', 'pnpm lint')],
        });

        expect(step).toBe('Running pnpm lint');
    });

    it('prefers a running tool over a thought that is also running', () => {
        const step = delegationChatStep({
            activeTurnId: 'turn',
            items: [command('a', 'turn', 'pnpm lint'), reasoning('b', 'turn', 'Planning')],
        });

        expect(step).toBe('Running pnpm lint');
    });

    it('keeps naming the newest step between two tool calls', () => {
        const step = delegationChatStep({
            activeTurnId: 'turn',
            items: [command('a', 'turn', 'pnpm lint', 'completed'), message('b', 'turn')],
        });

        expect(step).toBe('Ran pnpm lint');
    });

    it('reads only the active turn, never the work of an earlier one', () => {
        const items = [command('a', 'old', 'pnpm build', 'completed'), message('b', 'turn')];

        expect(delegationChatStep({ activeTurnId: 'turn', items })).toBeUndefined();
        expect(
            delegationChatStep({
                activeTurnId: 'turn',
                items: [...items, command('c', 'turn', 'pnpm lint')],
            }),
        ).toBe('Running pnpm lint');
    });

    it('has no step while no turn runs, or without a projection', () => {
        expect(delegationChatStep({ items: [command('a', 'turn', 'pnpm lint')] })).toBeUndefined();
        expect(delegationChatStep(undefined)).toBeUndefined();
    });

    it('collapses whitespace and clips a long step to the step bound', () => {
        const step = delegationChatStep({
            activeTurnId: 'turn',
            items: [command('a', 'turn', `echo   ${'word '.repeat(100)}`)],
        })!;

        expect(step).not.toMatch(/\s{2}/u);
        expect([...step]).toHaveLength(MAX_DELEGATION_STEP_LENGTH);
        expect(step.endsWith('…')).toBe(true);
    });
});

describe('delegationUsageLimitResetsAt', () => {
    const notice = (
        id: string,
        turnId: string,
        usageLimit?: { window: 'weekly' | 'session'; resetsAt?: number },
    ): AgentChatItem => ({
        id,
        turnId,
        type: 'notice',
        kind: 'error',
        ...(usageLimit && { usageLimit }),
    });

    it('reads the reset time the provider put on the failed turn, the newest notice winning', () => {
        const items = [
            notice('a', 'turn', { window: 'session', resetsAt: 5000 }),
            notice('b', 'turn', { window: 'weekly', resetsAt: 9000 }),
            notice('c', 'other', { window: 'weekly', resetsAt: 12_000 }),
        ];

        expect(delegationUsageLimitResetsAt({ items }, 'turn')).toBe(9000);
    });

    it('has none when the failure was not a plan limit, or the provider named no time', () => {
        expect(
            delegationUsageLimitResetsAt({ items: [notice('a', 'turn')] }, 'turn'),
        ).toBeUndefined();
        expect(
            delegationUsageLimitResetsAt(
                { items: [notice('a', 'turn', { window: 'weekly' })] },
                'turn',
            ),
        ).toBeUndefined();
        expect(delegationUsageLimitResetsAt(undefined, 'turn')).toBeUndefined();
    });
});
