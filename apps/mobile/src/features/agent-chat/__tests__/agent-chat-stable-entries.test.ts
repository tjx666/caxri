import type { AgentChatItem } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    createAgentChatEntryStabilizer,
    isSameAgentChatValue,
    stabilizeAgentChatEntries,
} from '../agent-chat-stable-entries';
import type { AgentChatTimelineEntry } from '../agent-chat-timeline';
import {
    buildAgentChatTimeline,
    isAgentChatTurnStart,
    withAgentChatPendingEntries,
} from '../agent-chat-timeline';

const items = (reply: string): AgentChatItem[] => [
    { id: 'u1', turnId: 't1', type: 'userMessage', text: 'Fix the build' },
    {
        id: 'c1',
        turnId: 't1',
        type: 'command',
        command: 'pnpm build',
        output: '',
        status: 'completed',
    },
    {
        id: 'c2',
        turnId: 't1',
        type: 'command',
        command: 'pnpm test',
        output: '',
        status: 'running',
    },
    { id: 'a1', turnId: 't1', type: 'agentMessage', text: reply, streaming: true },
];

const timeline = (snapshotItems: AgentChatItem[]) =>
    buildAgentChatTimeline({ activeTurnId: 't1', items: snapshotItems, turns: [] });
const timelineWith = (reply: string) => timeline(items(reply));
const ids = (entries: readonly AgentChatTimelineEntry[]): string[] =>
    entries.map((entry) => entry.id);

describe('isSameAgentChatValue', () => {
    it('compares nested data rather than identity', () => {
        expect(isSameAgentChatValue({ a: [1, { b: 'x' }] }, { a: [1, { b: 'x' }] })).toBe(true);
        expect(isSameAgentChatValue({ a: [1, { b: 'x' }] }, { a: [1, { b: 'y' }] })).toBe(false);
        expect(isSameAgentChatValue({ a: 1 }, { a: 1, b: undefined })).toBe(false);
        expect(isSameAgentChatValue([1], { 0: 1 })).toBe(false);
        expect(isSameAgentChatValue(null, {})).toBe(false);
    });
});

describe('stabilizeAgentChatEntries', () => {
    it('keeps every row a streamed patch did not touch as the same object', () => {
        const before = items('Building');
        const first = timeline(before);
        const patched = [
            ...before.slice(0, 3),
            { ...before[3], text: 'Building now' } as AgentChatItem,
        ];
        const second = stabilizeAgentChatEntries(first, timeline(patched));
        expect(second).not.toBe(first);
        expect(second.slice(0, -1)).toEqual(first.slice(0, -1));
        second.slice(0, -1).forEach((entry, index) => expect(entry).toBe(first[index]));
        expect(second.at(-1)).not.toBe(first.at(-1));
        expect(second.at(-1)).toMatchObject({ kind: 'message', message: { text: 'Building now' } });
    });

    it('returns the previous array when no row changed', () => {
        const first = timelineWith('Done');
        expect(stabilizeAgentChatEntries(first, timelineWith('Done'))).toBe(first);
    });

    it('takes new rows and drops removed ones', () => {
        const first = timelineWith('Done');
        const pending = withAgentChatPendingEntries(timelineWith('Done'), {
            notices: [],
            timeline: [{ id: 'm1', text: 'Next', imageUris: [] }],
        });
        const second = stabilizeAgentChatEntries(first, pending);
        expect(ids(second)).toEqual([...ids(first), 'pending:m1']);
        expect(second[0]).toBe(first[0]);
        const third = stabilizeAgentChatEntries(second, timelineWith('Done'));
        expect(ids(third)).toEqual(ids(first));
    });

    it('remembers the last result per list', () => {
        const stabilize = createAgentChatEntryStabilizer<AgentChatTimelineEntry>();
        const first = stabilize(timelineWith('Done'));
        expect(stabilize(timelineWith('Done'))).toBe(first);
        expect(stabilize(timelineWith('Done!'))[0]).toBe(first[0]);
    });
});

describe('isAgentChatTurnStart', () => {
    it('marks user messages and messages on their way', () => {
        const entries = withAgentChatPendingEntries(timelineWith('Done'), {
            notices: [],
            timeline: [{ id: 'm1', text: 'Next', imageUris: [] }],
        });
        expect(entries.filter(isAgentChatTurnStart).map((entry) => entry.id)).toEqual([
            'u1',
            'pending:m1',
        ]);
    });
});
