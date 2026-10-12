import { describe, expect, it } from 'vitest';

import {
    agentChatOutputLanguage,
    agentChatToolCallArguments,
    stripLineNumberGutter,
} from '../agent-chat-work-output';

describe('agentChatOutputLanguage', () => {
    const run = (text: string, output = 'x') =>
        agentChatOutputLanguage({
            id: 'c',
            type: 'command',
            command: text,
            status: 'completed',
            output,
        });

    it('infers the language of a printed file, a Git diff, JSON, or else the shell', () => {
        expect(run(`/bin/zsh -lc "sed -n '1,420p' /work/skills/SKILL.md"`)).toBe('md');
        expect(run('cat src/app.ts')).toBe('ts');
        expect(run('git -C repo diff HEAD~1')).toBe('diff');
        expect(run('git show --stat HEAD')).toBe('shell');
        expect(run('agent-browser skills get core --full | sed -n 1,700p')).toBe('shell');
        expect(run('gh api repos/a/b', '{"ok": true}')).toBe('json');
        // Any other command output is painted as the shell it came from.
        expect(run('ls -la', 'total 0')).toBe('shell');
    });

    it('uses the path a file tool read', () => {
        expect(
            agentChatOutputLanguage({
                id: 't',
                type: 'toolCall',
                name: 'Read',
                summary: '/work/src/main.py',
                status: 'completed',
                output: 'print(1)',
            }),
        ).toBe('py');
    });
});

describe('stripLineNumberGutter', () => {
    it("drops Claude Code's Read line numbers only when every line has one", () => {
        expect(stripLineNumberGutter('     1→const a = 1;\n     2→\n')).toBe('const a = 1;\n\n');
        expect(stripLineNumberGutter('1→a\nplain')).toBe('1→a\nplain');
    });
});

describe('agentChatToolCallArguments', () => {
    it('shows the JSON arguments behind a readable title, else the summary', () => {
        expect(
            agentChatToolCallArguments({ summary: 'to lead: Done', input: '{"to":"lead"}' }),
        ).toBe('{"to":"lead"}');
        expect(agentChatToolCallArguments({ summary: 'https://a.test' })).toBe('https://a.test');
        expect(agentChatToolCallArguments({})).toBeUndefined();
    });
});
