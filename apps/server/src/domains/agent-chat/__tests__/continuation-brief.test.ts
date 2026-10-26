import type { AgentChatItem } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { buildContinuationBrief } from '../continuation/continuation-brief';

const encoder = new TextEncoder();

function user(id: string, text: string): AgentChatItem {
    return { id, type: 'userMessage', text };
}

function agent(id: string, text: string): AgentChatItem {
    return { id, type: 'agentMessage', text, streaming: false };
}

describe('buildContinuationBrief', () => {
    it('leads with why and what to check, then the request, plan, files, and conversation', () => {
        const brief = buildContinuationBrief({
            snapshot: {
                items: [
                    user('u1', 'Add a parser for the config file'),
                    agent('a1', 'I will start with the tokenizer.'),
                    {
                        id: 'c1',
                        type: 'command',
                        command: 'bun test',
                        status: 'completed',
                        exitCode: 1,
                    } as AgentChatItem,
                    {
                        id: 'f1',
                        type: 'fileChange',
                        status: 'completed',
                        changes: [{ path: 'src/parser.ts', kind: 'add' }],
                    } as AgentChatItem,
                    { id: 'r1', type: 'reasoning', text: 'private thoughts' } as AgentChatItem,
                    user('u2', 'Also handle comments'),
                ],
                plan: {
                    steps: [
                        { step: 'Tokenizer', status: 'completed' },
                        { step: 'Comments', status: 'inProgress' },
                    ],
                } as never,
            },
            source: 'claude',
            reason: { kind: 'usageLimit', window: 'session' },
        });
        expect(brief).toContain('it stopped because Claude hit its 5-hour usage limit');
        expect(brief).toContain('`git status`');
        expect(brief.indexOf('## Latest request\n\nAlso handle comments')).toBeGreaterThan(0);
        expect(brief).toContain('- [x] Tokenizer\n- [ ] Comments');
        expect(brief).toContain('## Files changed in this conversation\n\n- src/parser.ts');
        expect(brief).toContain('- Ran `bun test` (exit 1)');
        expect(brief).not.toContain('private thoughts');
        expect(brief.indexOf('- User: Add a parser')).toBeLessThan(
            brief.indexOf('- User: Also handle comments'),
        );
    });

    it('puts a generated hand-off first and fits the delegation prompt limit', () => {
        const items = Array.from({ length: 400 }, (_, index) =>
            index % 2 === 0
                ? user(`u${index}`, `request ${index} ${'x'.repeat(400)}`)
                : agent(`a${index}`, `reply ${index} ${'y'.repeat(400)}`),
        );
        const brief = buildContinuationBrief({
            snapshot: { items, plan: undefined },
            source: 'codex',
            reason: { kind: 'usageGuard' },
            document: `# Hand-off\n\n${'z'.repeat(20_000)}\u{7}`,
        });
        expect(encoder.encode(brief).length).toBeLessThanOrEqual(15_000);
        expect(brief).toContain("Codex's weekly usage reached the guard");
        expect(brief.indexOf('## Hand-off written by Codex')).toBeLessThan(
            brief.indexOf('## Latest request'),
        );
        // The newest conversation survives the budget; the oldest is dropped.
        expect(brief).toContain('reply 399');
        expect(brief).not.toContain('request 0 ');
        // eslint-disable-next-line no-control-regex -- asserting the brief contains none.
        expect(brief).not.toMatch(/[\u{0}-\u{8}\u{B}-\u{1F}\u{7F}]/u);
    });
});
