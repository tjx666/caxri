import { describe, expect, it } from 'vitest';

import { buildAgentChatTimeline, isAgentChatTurnStart } from '../agent-chat-timeline';

describe('buildAgentChatTimeline delegated tasks', () => {
    it('draws a delegated task pointer as its own turn-starting row', () => {
        const text =
            'Read the delegated task from "/tmp/task.md" and carry it out. Delegation ID: d1.';
        const snapshot = {
            items: [
                {
                    id: 'u1',
                    turnId: 't1',
                    type: 'userMessage',
                    text,
                    delegatedTask: {
                        delegationId: 'd1',
                        source: { kind: 'session', sessionId: 's1' },
                    },
                },
                { id: 'u2', turnId: 't2', type: 'userMessage', text: 'Plain message' },
            ],
            turns: [
                { id: 't1', status: 'completed' },
                { id: 't2', status: 'completed' },
            ],
        } satisfies Parameters<typeof buildAgentChatTimeline>[0];
        const entries = buildAgentChatTimeline(snapshot);
        expect(entries[0]).toEqual({
            kind: 'delegated',
            id: 'u1',
            body: { kind: 'pointer' },
            isExpanded: false,
            text,
            task: { delegationId: 'd1', source: { kind: 'session', sessionId: 's1' } },
        });
        expect(isAgentChatTurnStart(entries[0])).toBe(true);
        expect(entries.find((entry) => entry.id === 'u2')).toMatchObject({ kind: 'message' });
        // The list owns the unfolded pointer, so FlashList re-measures the row instead of a recycled row keeping it.
        expect(buildAgentChatTimeline(snapshot, new Set(['u1']))[0]).toMatchObject({
            isExpanded: true,
        });
    });

    it("shows a delegated task's prompt, and falls back to the pointer once its record is gone (#2307)", () => {
        const text =
            'Read the delegated task from "/tmp/task.md" and carry it out. Delegation ID: d1.';
        const task = (prompt?: string) => ({
            items: [
                {
                    id: 'u1',
                    turnId: 't1',
                    type: 'userMessage' as const,
                    text,
                    delegatedTask: {
                        delegationId: 'd1',
                        ...(prompt !== undefined && { prompt }),
                    },
                },
            ],
            turns: [{ id: 't1', status: 'completed' as const }],
        });
        expect(buildAgentChatTimeline(task('Rename the helper'))[0]).toMatchObject({
            kind: 'delegated',
            body: { kind: 'prompt', prompt: 'Rename the helper' },
            text,
        });
        expect(buildAgentChatTimeline(task())[0]).toMatchObject({
            kind: 'delegated',
            body: { kind: 'pointer' },
            text,
        });
        // An empty prompt says nothing either, so the pointer stays reachable.
        expect(buildAgentChatTimeline(task(''))[0]).toMatchObject({ body: { kind: 'pointer' } });
    });
});
