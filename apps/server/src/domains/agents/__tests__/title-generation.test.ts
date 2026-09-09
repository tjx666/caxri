import { describe, expect, it } from 'vitest';

import {
    buildAgentTitlePrompt,
    extractAgentTitleMessage,
    normalizeGeneratedAgentTitle,
} from '../title-generation';

describe('Session title material', () => {
    it('uses real conversation text and excludes instructions, tools and duplicate Codex events', () => {
        expect(
            extractAgentTitleMessage({
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'input_text', text: 'Fix the session rename race' }],
                },
            }),
        ).toEqual({ role: 'user', text: 'Fix the session rename race' });
        expect(
            extractAgentTitleMessage({
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'user',
                    content: [
                        {
                            type: 'input_text',
                            text: '# AGENTS.md instructions for /project\nFollow these rules',
                        },
                    ],
                },
            }),
        ).toBeUndefined();
        expect(
            extractAgentTitleMessage({
                type: 'user',
                message: { content: [{ type: 'tool_result', content: 'Unrelated branch topic' }] },
            }),
        ).toBeUndefined();
        expect(
            extractAgentTitleMessage({
                type: 'event_msg',
                payload: { type: 'user_message', message: 'Duplicate' },
            }),
        ).toBeUndefined();
        expect(
            extractAgentTitleMessage({
                type: 'assistant',
                message: {
                    content: [
                        { type: 'text', text: 'The title reader used the wrong precedence.' },
                    ],
                },
            }),
        ).toEqual({ role: 'assistant', text: 'The title reader used the wrong precedence.' });
    });

    it('does not introduce branch or previous-title anchoring into the prompt', () => {
        const prompt = buildAgentTitlePrompt([
            { role: 'user', text: 'Investigate <image> rename behavior' },
            { role: 'assistant', text: 'The task is session title synchronization.' },
        ]);
        expect(prompt).toContain('session title synchronization');
        expect(prompt).not.toContain('git_branch');
        expect(prompt).toContain('&lt;image&gt;');
    });

    it('rejects empty, generic, multiline and oversized titles', () => {
        for (const title of [
            '',
            'SKIP',
            '分析图片内容',
            'Analyze Image',
            'First\nSecond',
            'x'.repeat(81),
        ])
            expect(normalizeGeneratedAgentTitle(title)).toBeUndefined();
        expect(normalizeGeneratedAgentTitle('  Session rename synchronization  ')).toBe(
            'Session rename synchronization',
        );
        expect(normalizeGeneratedAgentTitle('会话标题同步')).toBe('会话标题同步');
    });
});
