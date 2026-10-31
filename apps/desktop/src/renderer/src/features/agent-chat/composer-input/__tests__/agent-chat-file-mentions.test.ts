import { describe, expect, it } from 'vitest';

import {
    agentChatFileSuggestion,
    agentChatMentionActiveIndex,
    agentChatMentionHeadingAt,
    agentChatMentionRows,
    agentChatMentionRowSuggestion,
    agentChatMentionStep,
    openFileMentions,
    rankAgentChatFileMentions,
} from '../agent-chat-file-mentions';

describe('rankAgentChatFileMentions', () => {
    it('puts the file-name match ahead of a directory-only hit, then the shallower path', () => {
        expect(
            rankAgentChatFileMentions(
                [
                    'src/session/helpers.ts',
                    'docs/session.md',
                    'session.ts',
                    'a/b/c/session.ts',
                    'src/my-session-list.ts',
                ],
                'session',
            ),
        ).toEqual([
            'session.ts',
            'docs/session.md',
            'a/b/c/session.ts',
            'src/my-session-list.ts',
            'src/session/helpers.ts',
        ]);
    });

    it('prefers the exact name over a prefix, and is stable for equal ranks', () => {
        expect(rankAgentChatFileMentions(['b/index.ts', 'a/index.ts', 'index'], 'index')).toEqual([
            'index',
            'a/index.ts',
            'b/index.ts',
        ]);
    });

    it('caps the list', () => {
        const paths = Array.from({ length: 20 }, (_, index) => `f${index}.ts`);
        expect(rankAgentChatFileMentions(paths, 'f', 3)).toHaveLength(3);
    });
});

describe('openFileMentions', () => {
    it('keeps Project-relative paths of open files, without repeats or outside files', () => {
        expect(
            openFileMentions(
                ['/work/app/src/a.ts', '/work/app/src/a.ts', '/elsewhere/b.ts', '/work/app/c.md'],
                '/work/app',
            ),
        ).toEqual(['src/a.ts', 'c.md']);
        expect(openFileMentions(['/work/app/a.ts'], undefined)).toEqual([]);
        expect(openFileMentions(['/work/app/a.ts'], '/work/app/')).toEqual(['a.ts']);
    });
});

describe('agentChatFileSuggestion', () => {
    it('shows the file name with its directory', () => {
        expect(agentChatFileSuggestion('src/app/main.ts')).toEqual({
            key: 'file-src/app/main.ts',
            label: 'main.ts',
            isLabelLiteral: false,
            description: 'src/app',
        });
        expect(agentChatFileSuggestion('README.md')).toEqual({
            key: 'file-README.md',
            label: 'README.md',
            isLabelLiteral: false,
        });
    });
});

describe('agentChatMentionHeadingAt', () => {
    it('starts Files first and Sessions after them', () => {
        expect([0, 1, 2, 3].map((index) => agentChatMentionHeadingAt(2, index))).toEqual([
            'files',
            undefined,
            'sessions',
            undefined,
        ]);
        expect([0, 1].map((index) => agentChatMentionHeadingAt(0, index))).toEqual([
            'sessions',
            undefined,
        ]);
    });
});

describe('merged @ list rows', () => {
    const candidate = {
        sessionId: 's1',
        title: 'Fix login',
        projectName: 'Caxri',
    } as unknown as Parameters<typeof agentChatMentionRows>[1][number];

    it('lists the files before the Sessions and draws each by kind', () => {
        const rows = agentChatMentionRows(['src/a.ts'], [candidate]);
        expect(rows.map((row) => row.kind)).toEqual(['file', 'session']);
        expect(agentChatMentionRowSuggestion(rows[0]).key).toBe('file-src/a.ts');
        expect(agentChatMentionRowSuggestion(rows[1]).key).not.toBe('file-src/a.ts');
    });

    it('keeps the highlight only for an unchanged query and clamps it to the last row', () => {
        expect(agentChatMentionActiveIndex({ query: 'a', index: 5 }, 'a', 3)).toBe(2);
        expect(agentChatMentionActiveIndex({ query: 'a', index: 1 }, 'a', 3)).toBe(1);
        expect(agentChatMentionActiveIndex({ query: 'a', index: 1 }, 'ab', 3)).toBe(0);
    });

    it('wraps arrow steps at both ends', () => {
        expect(agentChatMentionStep(2, 1, 3)).toBe(0);
        expect(agentChatMentionStep(0, -1, 3)).toBe(2);
        expect(agentChatMentionStep(1, 1, 3)).toBe(2);
    });
});
