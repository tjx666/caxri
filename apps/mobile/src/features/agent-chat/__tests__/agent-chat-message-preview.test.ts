import { describe, expect, it } from 'vitest';

import type { AgentChatTimelineEntry } from '../agent-chat-timeline';
import { agentChatMessagePreview } from '../agent-chat-timeline';

const t = (key: string): string => key;

const userMessage = (text: string): AgentChatTimelineEntry => ({
    kind: 'message',
    id: 'u1',
    message: { id: 'u1', type: 'userMessage', text },
});

describe('agentChatMessagePreview', () => {
    it('previews the words of a user message', () => {
        expect(agentChatMessagePreview(userMessage('Fix the login bug'), t)).toBe(
            'Fix the login bug',
        );
    });

    it('previews the text a relayed message carries, not its protocol line', () => {
        const relayed = userMessage(
            "[Caxri] Relayed from another Session at the user's request:\n\nShip it",
        );
        expect(agentChatMessagePreview(relayed, t)).toBe('Ship it');
    });

    it('names the skills and files a message cites when it has no words', () => {
        const cited: AgentChatTimelineEntry = {
            ...userMessage(''),
            cited: {
                references: [
                    { isDirectory: false, path: '/project/src/app.ts' },
                    { isDirectory: true, path: '/project/docs/' },
                ],
                skills: [{ name: 'debug' }],
            },
        } as AgentChatTimelineEntry;
        expect(agentChatMessagePreview(cited, t)).toBe('debug, app.ts, docs');
        const worded = { ...cited, message: { id: 'u1', type: 'userMessage', text: 'Look' } };
        expect(agentChatMessagePreview(worded as AgentChatTimelineEntry, t)).toBe('Look');
    });

    it('previews a delegated task by its prompt, or names it when the prompt is gone', () => {
        const task = {
            kind: 'delegated',
            id: 'd1',
            isExpanded: false,
            text: 'pointer',
        } as const;
        expect(
            agentChatMessagePreview(
                { ...task, body: { kind: 'prompt', prompt: 'Review the PR' } } as never,
                t,
            ),
        ).toBe('Review the PR');
        expect(agentChatMessagePreview({ ...task, body: { kind: 'pointer' } } as never, t)).toBe(
            'chat.delegated.task',
        );
    });

    it('lists a message still on its way', () => {
        const pending = {
            kind: 'pending',
            id: 'pending:p1',
            text: 'Queued',
            imageUris: [],
            wait: 'delivery',
        } as const;
        expect(agentChatMessagePreview(pending, t)).toBe('Queued');
    });

    it('skips replies and settlement notices', () => {
        const reply: AgentChatTimelineEntry = {
            kind: 'message',
            id: 'a1',
            message: { id: 'a1', type: 'agentMessage', text: 'Done' },
        };
        expect(agentChatMessagePreview(reply, t)).toBeUndefined();
        expect(
            agentChatMessagePreview({ kind: 'delegationNotice', id: 'n1' } as never, t),
        ).toBeUndefined();
    });
});
