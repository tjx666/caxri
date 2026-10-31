import { describe, expect, it } from 'vitest';

import { agentChatPathReferencePreview } from '../../agent/agent-chat-path-references.js';
import {
    agentChatSessionReferenceRanges,
    agentChatTextWithSessionMentions,
    formatAgentChatFileMention,
    formatAgentChatSessionReference,
    searchSessionReferenceCandidates,
} from '../session-conversation-reference.js';

describe('formatAgentChatFileMention', () => {
    it('quotes a path with whitespace and leaves others bare', () => {
        expect(formatAgentChatFileMention('src/a.ts')).toBe('@src/a.ts');
        expect(formatAgentChatFileMention('my docs/a b.md')).toBe('@"my docs/a b.md"');
    });
});

describe('searchSessionReferenceCandidates', () => {
    const session = (id: string, title: string, lastVisitedAt: number) => ({
        id,
        title,
        lastVisitedAt,
        primaryAgentTerminalId: `t-${id}`,
    });

    it('ranks a title prefix over a word start over a substring, then the most recently opened', () => {
        const sessions = [
            session('substring', 'Relogin flow', 9),
            session('word', 'Fix login', 1),
            session('prefix-old', 'Login page', 2),
            session('prefix-new', 'Login form', 3),
            { ...session('shell', 'Login shell', 9), primaryAgentTerminalId: undefined },
        ];
        expect(
            searchSessionReferenceCandidates(sessions, undefined, 'login').map(({ id }) => id),
        ).toEqual(['prefix-new', 'prefix-old', 'word', 'substring']);
    });
});

describe('formatAgentChatSessionReference', () => {
    it('cites the file and names the Session in one sentence', () => {
        expect(
            formatAgentChatSessionReference({
                filePath: '/tmp/refs/session-1.md',
                title: 'Fix "login"',
            }),
        ).toBe(
            String.raw`@/tmp/refs/session-1.md contains the conversation from Session "Fix \"login\"".`,
        );
    });

    it('quotes a path with whitespace so the mention does not end early', () => {
        expect(formatAgentChatSessionReference({ filePath: '/a b/c.md', title: 'T' })).toBe(
            '@"/a b/c.md" contains the conversation from Session "T".',
        );
    });
});

describe('agentChatSessionReferenceRanges', () => {
    it('round-trips every reference the formatter writes, including quotes, spaces, and Chinese', () => {
        const references = [
            { filePath: '/tmp/refs/session-1.md', title: 'Fix login' },
            { filePath: '/Users/x b/refs/session-2.md', title: '修复 "登录" 问题' },
            { filePath: '/tmp/refs/session-3.md', title: String.raw`back\slash` },
            { filePath: '/tmp/refs/session-4.md', title: '' },
        ];
        const parts = references.map((reference) => formatAgentChatSessionReference(reference));
        const text = `see ${parts[0]} and\n${parts[1]}${parts[2]} ${parts[3]} done`;
        const ranges = agentChatSessionReferenceRanges(text);
        expect(ranges.map(({ path, title }) => ({ filePath: path, title }))).toEqual(references);
        expect(ranges.map(({ from, to }) => text.slice(from, to))).toEqual(parts);
    });

    it('keeps two Sessions with the same title apart', () => {
        const first = formatAgentChatSessionReference({ filePath: '/r/a.md', title: 'Same' });
        const second = formatAgentChatSessionReference({ filePath: '/r/b.md', title: 'Same' });
        expect(
            agentChatSessionReferenceRanges(`${first} ${second}`).map(({ path }) => path),
        ).toEqual(['/r/a.md', '/r/b.md']);
    });

    it('leaves a plain mention or a sentence the user broke as text', () => {
        expect(agentChatSessionReferenceRanges('@/tmp/a.md is the file')).toEqual([]);
        expect(
            agentChatSessionReferenceRanges(
                '@/tmp/a.md contains the conversation from Session "Fix login"',
            ),
        ).toEqual([]);
        expect(
            agentChatSessionReferenceRanges(
                '@relative.md contains the conversation from Session "Fix login".',
            ),
        ).toEqual([]);
    });
});

describe('agentChatTextWithSessionMentions', () => {
    it('writes each cited Session as its @title mention', () => {
        const reference = formatAgentChatSessionReference({
            filePath: '/tmp/refs/s.md',
            title: 'Fix login',
        });
        expect(agentChatTextWithSessionMentions(`Compare ${reference} with this`)).toBe(
            'Compare @Fix login with this',
        );
    });

    it('names the cited Session in a queue or rail preview', () => {
        const reference = formatAgentChatSessionReference({
            filePath: '/tmp/refs/s.md',
            title: 'Fix login',
        });
        expect(agentChatPathReferencePreview(`${reference} what next?`)).toBe(
            '@Fix login what next?',
        );
    });
});
