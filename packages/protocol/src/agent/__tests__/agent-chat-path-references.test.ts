import { describe, expect, it } from 'vitest';

import {
    agentChatPathReferenceName,
    agentChatPathReferencePreview,
    agentChatTextWithPathReferences,
    parseAgentChatPathReferences,
} from '../agent-chat-path-references';

const references = [
    { path: '/work/play/prettier-config', isDirectory: true },
    { path: '/work/play/notes.md', isDirectory: false },
];

describe('agent chat path references', () => {
    it('writes references ahead of the request in the Codex app layout', () => {
        expect(agentChatTextWithPathReferences('tidy these', references, 'Codex')).toBe(
            [
                '# Files mentioned by the user:',
                '',
                '## prettier-config: /work/play/prettier-config/',
                '',
                '## notes.md: /work/play/notes.md',
                '',
                '## My request for Codex:',
                'tidy these',
            ].join('\n'),
        );
        expect(agentChatTextWithPathReferences('hi', [])).toBe('hi');
    });

    it('reads the references back and keeps what the user typed', () => {
        for (const provider of ['Codex', 'Claude Code', undefined]) {
            const text = agentChatTextWithPathReferences('tidy\nthese', references, provider);
            expect(parseAgentChatPathReferences(text)).toEqual({
                references,
                text: 'tidy\nthese',
            });
        }
        expect(
            parseAgentChatPathReferences(agentChatTextWithPathReferences('', references)),
        ).toEqual({ references, text: '' });
    });

    it('leaves ordinary text alone, including a look-alike heading', () => {
        expect(parseAgentChatPathReferences('plain message')).toEqual({
            references: [],
            text: 'plain message',
        });
        const lookalike = '# Files mentioned by the user:\n\n## not a path\n\n## My request:\nhi';
        expect(parseAgentChatPathReferences(lookalike)).toEqual({
            references: [],
            text: lookalike,
        });
    });

    it('names a reference by its last segment', () => {
        expect(agentChatPathReferenceName({ path: '/work/play/prettier-config' })).toBe(
            'prettier-config',
        );
        expect(agentChatPathReferenceName({ path: '/' })).toBe('/');
    });

    it('previews a message by its words, or by what it cites when it has none', () => {
        const message = agentChatTextWithPathReferences('tidy these', references, 'Codex');
        expect(agentChatPathReferencePreview(message)).toBe('tidy these');
        expect(
            agentChatPathReferencePreview(agentChatTextWithPathReferences('', references, 'Codex')),
        ).toBe('prettier-config, notes.md');
        // A queue preview clipped inside the block still names the references it holds.
        expect(agentChatPathReferencePreview(message.slice(0, 70))).toBe('prettier-config');
        expect(agentChatPathReferencePreview('plain')).toBe('plain');
    });
});
