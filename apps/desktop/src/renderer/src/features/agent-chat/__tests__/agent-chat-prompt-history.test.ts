import type { AgentChatItem } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { AgentChatPromptHistoryEntry } from '../agent-chat-prompt-history';
import {
    agentChatPromptHistory,
    agentChatPromptHistoryDirection,
    stepAgentChatPromptHistory,
} from '../agent-chat-prompt-history';

const user = (id: string, text: string): AgentChatItem => ({
    id,
    type: 'userMessage',
    text,
});

const entries: AgentChatPromptHistoryEntry[] = [
    { id: 'u1', prompt: 'first' },
    { id: 'u2', prompt: 'second' },
    { id: 'u3', prompt: 'third' },
];

const bare = {
    altKey: false,
    ctrlKey: false,
    isComposing: false,
    metaKey: false,
    shiftKey: false,
};

describe('agentChatPromptHistory', () => {
    it('lists sent prompts oldest first, collapsing repeats and skipping image-only messages', () => {
        const items: AgentChatItem[] = [
            user('u1', 'first'),
            {
                id: 'a1',
                type: 'agentMessage',
                text: 'reply',
                streaming: false,
            },
            user('u2', '  again  '),
            user('u3', 'again'),
            user('u4', ''),
            user('u5', 'last'),
        ];
        expect(agentChatPromptHistory(items)).toEqual([
            { id: 'u1', prompt: 'first' },
            { id: 'u3', prompt: 'again' },
            { id: 'u5', prompt: 'last' },
        ]);
        expect(agentChatPromptHistory(undefined)).toEqual([]);
    });
});

describe('agentChatPromptHistoryDirection', () => {
    const input = (value: string, caret: number) => ({
        value,
        selectionStart: caret,
        selectionEnd: caret,
    });

    it('steps only on a bare arrow with the caret on the edge line', () => {
        expect(agentChatPromptHistoryDirection({ ...bare, key: 'ArrowUp' }, input('', 0))).toBe(
            'backward',
        );
        expect(agentChatPromptHistoryDirection({ ...bare, key: 'ArrowDown' }, input('', 0))).toBe(
            'forward',
        );
        // A multi-line prompt moves line by line until the caret reaches its first or last line.
        expect(
            agentChatPromptHistoryDirection({ ...bare, key: 'ArrowUp' }, input('one\ntwo', 7)),
        ).toBeUndefined();
        expect(
            agentChatPromptHistoryDirection({ ...bare, key: 'ArrowUp' }, input('one\ntwo', 2)),
        ).toBe('backward');
        expect(
            agentChatPromptHistoryDirection({ ...bare, key: 'ArrowDown' }, input('one\ntwo', 2)),
        ).toBeUndefined();
        expect(
            agentChatPromptHistoryDirection({ ...bare, key: 'ArrowUp' }, input('\none', 0)),
        ).toBe('backward');
    });

    it('leaves modified keys, IME composition, selections, and other keys alone', () => {
        for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey', 'isComposing'])
            expect(
                agentChatPromptHistoryDirection(
                    { ...bare, [modifier]: true, key: 'ArrowUp' },
                    input('', 0),
                ),
            ).toBeUndefined();
        expect(
            agentChatPromptHistoryDirection(
                { ...bare, key: 'ArrowUp' },
                { value: 'abc', selectionStart: 0, selectionEnd: 2 },
            ),
        ).toBeUndefined();
        expect(
            agentChatPromptHistoryDirection({ ...bare, key: 'ArrowLeft' }, input('', 0)),
        ).toBeUndefined();
    });
});

describe('stepAgentChatPromptHistory', () => {
    it('walks back from an empty input, stops at the oldest, and walks forward back to empty', () => {
        const up1 = stepAgentChatPromptHistory({
            current: '',
            direction: 'backward',
            entries,
            position: undefined,
        });
        expect(up1?.prompt).toBe('third');
        const up2 = stepAgentChatPromptHistory({
            current: 'third',
            direction: 'backward',
            entries,
            position: up1?.position,
        });
        expect(up2?.prompt).toBe('second');
        const up3 = stepAgentChatPromptHistory({
            current: 'second',
            direction: 'backward',
            entries,
            position: up2?.position,
        });
        expect(up3?.prompt).toBe('first');
        expect(
            stepAgentChatPromptHistory({
                current: 'first',
                direction: 'backward',
                entries,
                position: up3?.position,
            }),
        ).toBeUndefined();

        const down1 = stepAgentChatPromptHistory({
            current: 'first',
            direction: 'forward',
            entries,
            position: up3?.position,
        });
        expect(down1?.prompt).toBe('second');
        const down2 = stepAgentChatPromptHistory({
            current: 'third',
            direction: 'forward',
            entries,
            position: { entryId: 'u3', recalled: 'third' },
        });
        expect(down2).toEqual({ position: undefined, prompt: '' });
    });

    it('never replaces a draft the user typed or edited', () => {
        expect(
            stepAgentChatPromptHistory({
                current: 'my own text',
                direction: 'backward',
                entries,
                position: undefined,
            }),
        ).toBeUndefined();
        // The recalled prompt was edited, so browsing is over.
        expect(
            stepAgentChatPromptHistory({
                current: 'second, edited',
                direction: 'backward',
                entries,
                position: { entryId: 'u2', recalled: 'second' },
            }),
        ).toBeUndefined();
        expect(
            stepAgentChatPromptHistory({
                current: '',
                direction: 'forward',
                entries,
                position: undefined,
            }),
        ).toBeUndefined();
        expect(
            stepAgentChatPromptHistory({
                current: '',
                direction: 'backward',
                entries: [],
                position: undefined,
            }),
        ).toBeUndefined();
    });

    it('keeps its place when the recalled entry collapsed into a newer identical prompt', () => {
        const step = stepAgentChatPromptHistory({
            current: 'second',
            direction: 'backward',
            entries: [
                { id: 'u1', prompt: 'first' },
                { id: 'u9', prompt: 'second' },
            ],
            position: { entryId: 'u2', recalled: 'second' },
        });
        expect(step?.prompt).toBe('first');
    });
});
