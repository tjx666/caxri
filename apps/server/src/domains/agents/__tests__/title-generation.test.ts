import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    buildAgentTitlePrompt,
    extractAgentTitleMessage,
    normalizeGeneratedAgentTitle,
    readAgentTitleMessages,
} from '../title-generation';
import type { AgentTranscriptLocation } from '../transcript-security';

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

    it('separates the opening request from the latest exchange in the prompt', () => {
        const prompt = buildAgentTitlePrompt({
            opening: [
                { role: 'user', text: 'Investigate <image> rename behavior' },
                { role: 'assistant', text: 'The task is session title synchronization.' },
            ],
            recent: [{ role: 'user', text: 'just cancel it' }],
        });
        expect(prompt).toContain('<opening_request>');
        expect(prompt).toContain('session title synchronization');
        expect(prompt).toContain('<recent_messages>');
        expect(prompt).toContain('just cancel it');
        expect(prompt).not.toContain('git_branch');
        expect(prompt).toContain('&lt;image&gt;');
    });

    it('omits an empty section instead of emitting an unmatched tag', () => {
        const prompt = buildAgentTitlePrompt({
            opening: [{ role: 'user', text: 'Only request' }],
            recent: [],
        });
        expect(prompt).toContain('<opening_request>');
        expect(prompt).not.toContain('recent_messages');
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

describe('Session title transcript reading', () => {
    const codexUser = (text: string): string =>
        JSON.stringify({
            type: 'response_item',
            payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
        });
    const codexAssistant = (text: string): string =>
        JSON.stringify({
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text }],
            },
        });
    /**
     * Tool records carry no naming material but dominate a real transcript's byte size.
     */
    const toolNoise = (bytes: number): string =>
        JSON.stringify({
            type: 'response_item',
            payload: { type: 'function_call_output', output: 'x'.repeat(bytes) },
        });

    async function writeTranscript(lines: readonly string[]): Promise<AgentTranscriptLocation> {
        const baseRoot = await mkdtemp(join(tmpdir(), 'caxri-title-test-'));
        const root = join(baseRoot, 'project');
        await mkdir(root);
        const path = join(root, 'transcript.jsonl');
        await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
        return { baseRoot, path, root };
    }

    it('keeps the opening request when megabytes of tool output separate it from the latest turn', async () => {
        const location = await writeTranscript([
            codexUser('https://linear.app/lobehub/issue/LOBE-14090/bedrock-channel-errors'),
            codexAssistant('I will verify the Linear alert and the Bedrock channel routing.'),
            toolNoise(1_500_000),
            codexAssistant('The circuit breaker entries already cleared.'),
            codexUser('just cancel'),
            codexAssistant('Moved the issue to Canceled.'),
        ]);
        const context = await readAgentTitleMessages(location);
        expect(context.opening).toEqual([
            {
                role: 'user',
                text: 'https://linear.app/lobehub/issue/LOBE-14090/bedrock-channel-errors',
            },
            {
                role: 'assistant',
                text: 'I will verify the Linear alert and the Bedrock channel routing.',
            },
        ]);
        expect(context.recent.map((message) => message.text)).toEqual([
            'The circuit breaker entries already cleared.',
            'just cancel',
            'Moved the issue to Canceled.',
        ]);
        await rm(location.baseRoot, { force: true, recursive: true });
    });

    it('reports the opening exactly once and bounds the latest exchange', async () => {
        const location = await writeTranscript([
            codexUser('first request'),
            codexAssistant('first reply'),
            ...Array.from({ length: 10 }, (_, index) => codexAssistant(`step ${index}`)),
        ]);
        const context = await readAgentTitleMessages(location);
        expect(context.opening.map((message) => message.text)).toEqual([
            'first request',
            'first reply',
        ]);
        expect(context.recent).toHaveLength(6);
        expect(context.recent.map((message) => message.text)).not.toContain('first request');
        expect(context.recent.at(-1)?.text).toBe('step 9');
        await rm(location.baseRoot, { force: true, recursive: true });
    });

    it('decodes multi-byte text split across read chunks', async () => {
        const text = '排查熔断告警'.repeat(200);
        const location = await writeTranscript([
            codexUser(text),
            toolNoise(200_000),
            codexAssistant('完成'),
        ]);
        const context = await readAgentTitleMessages(location);
        expect(context.opening[0]?.text).toBe([...text].slice(0, 1600).join(''));
        expect(context.opening[0]?.text).not.toContain('�');
        await rm(location.baseRoot, { force: true, recursive: true });
    });
});

describe('Session title record bounds', () => {
    const message = (role: 'assistant' | 'user', text: string): string =>
        JSON.stringify({
            type: 'response_item',
            payload: {
                type: 'message',
                role,
                content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
            },
        });

    it('discards an oversized record and resumes at the next complete line', async () => {
        const baseRoot = await mkdtemp(join(tmpdir(), 'caxri-title-bound-'));
        const root = join(baseRoot, 'project');
        await mkdir(root);
        const path = join(root, 'transcript.jsonl');
        await writeFile(
            path,
            `${[
                message('user', 'opening request'),
                message('assistant', 'opening reply'),
                /**
                 * A parseable message this large is a paste, not naming material. Without the record bound it would
                 * both buffer whole in Server memory and occupy a slot in the latest exchange.
                 */
                message('user', `oversized paste ${'x'.repeat(700_000)}`),
                message('user', 'closing request'),
            ].join('\n')}\n`,
            'utf8',
        );
        const context = await readAgentTitleMessages({ baseRoot, path, root });
        expect(context.opening.map((entry) => entry.text)).toEqual([
            'opening request',
            'opening reply',
        ]);
        expect(context.recent.map((entry) => entry.text)).toEqual(['closing request']);
        await rm(baseRoot, { force: true, recursive: true });
    });
});
