import { agentChatTextWithPathReferences } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { agentChatPathChips } from '../agent-chat-path-chip-list';
import { buildAgentChatTimeline } from '../agent-chat-timeline';

describe('agentChatPathChips', () => {
    it('lists skills first, then files and folders by last path segment', () => {
        expect(
            agentChatPathChips(
                [
                    { path: '/work/notes.txt', isDirectory: false },
                    { path: '/work/docs', isDirectory: true },
                ],
                [{ name: 'caxri-cli' }],
            ),
        ).toEqual([
            { key: 'skill:caxri-cli', kind: 'skill', name: 'caxri-cli', path: undefined },
            {
                key: 'path:/work/notes.txt',
                kind: 'file',
                name: 'notes.txt',
                path: '/work/notes.txt',
            },
            { key: 'path:/work/docs', kind: 'folder', name: 'docs', path: '/work/docs' },
        ]);
    });
});

describe('user messages that cite files', () => {
    const sent = agentChatTextWithPathReferences(
        'look at this',
        [{ path: '/work/docs', isDirectory: true }],
        'Codex',
    );
    const timeline = (text: string) =>
        buildAgentChatTimeline({
            activeTurnId: undefined,
            items: [{ id: 'u1', turnId: 't1', type: 'userMessage', text }],
            turns: [],
        });

    it('shows only the typed words and splits the citations off', () => {
        const [entry] = timeline(sent);
        expect(entry).toMatchObject({
            kind: 'message',
            message: { text: 'look at this' },
            cited: { references: [{ path: '/work/docs', isDirectory: true }], skills: [] },
        });
    });

    it('leaves a plain message untouched', () => {
        const [entry] = timeline('hello');
        expect(entry).toMatchObject({ kind: 'message', message: { text: 'hello' } });
        expect(entry).not.toHaveProperty('cited');
    });
});
