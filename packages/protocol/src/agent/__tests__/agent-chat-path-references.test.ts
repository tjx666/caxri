import { describe, expect, it } from 'vitest';

import {
    agentChatPathReferenceName,
    agentChatPathReferencePreview,
    agentChatTextWithPathReferences,
    CAXRI_SKILL_NAME,
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
                skills: [],
                text: 'tidy\nthese',
            });
        }
        expect(
            parseAgentChatPathReferences(agentChatTextWithPathReferences('', references)),
        ).toEqual({ references, skills: [], text: '' });
    });

    it('round-trips the filesystem root as a folder', () => {
        const root = [{ path: '/', isDirectory: true }];
        const text = agentChatTextWithPathReferences('look', root, 'Codex');
        expect(text).toContain('## /: /\n');
        expect(parseAgentChatPathReferences(text)).toEqual({
            references: root,
            skills: [],
            text: 'look',
        });
        const mixed = [...root, ...references];
        expect(
            parseAgentChatPathReferences(agentChatTextWithPathReferences('x', mixed)).references,
        ).toEqual(mixed);
    });

    it('leaves ordinary text alone, including a look-alike heading', () => {
        expect(parseAgentChatPathReferences('plain message')).toEqual({
            references: [],
            skills: [],
            text: 'plain message',
        });
        const lookalike = '# Files mentioned by the user:\n\n## not a path\n\n## My request:\nhi';
        expect(parseAgentChatPathReferences(lookalike)).toEqual({
            references: [],
            skills: [],
            text: lookalike,
        });
        const skillLookalike =
            '# Skills the user asked you to use:\n\n## caxri-cli: hi\n\n## My request:\nhi';
        expect(parseAgentChatPathReferences(skillLookalike).skills).toEqual([]);
        expect(parseAgentChatPathReferences('## My request:\nhi').text).toBe('## My request:\nhi');
    });

    it('asks the Agent to load a skill ahead of the files and reads it back', () => {
        const skills = [{ name: CAXRI_SKILL_NAME }];
        const text = agentChatTextWithPathReferences('add a Session', references, 'Codex', skills);
        expect(text.split('\n').slice(0, 4)).toEqual([
            '# Skills the user asked you to use:',
            '',
            '## caxri-cli: run `"$CAXRI_CLI" skills get caxri-cli --full` and follow it',
            '',
        ]);
        expect(parseAgentChatPathReferences(text)).toEqual({
            references,
            skills,
            text: 'add a Session',
        });
        const skillOnly = agentChatTextWithPathReferences('', [], 'Claude Code', skills);
        expect(parseAgentChatPathReferences(skillOnly)).toEqual({
            references: [],
            skills,
            text: '',
        });
        expect(agentChatPathReferencePreview(skillOnly)).toBe('caxri-cli');
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
