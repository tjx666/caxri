import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
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
        ).toEqual({ isChunk: false, role: 'user', text: 'Fix the session rename race' });
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
        ).toEqual({
            isChunk: false,
            role: 'assistant',
            text: 'The title reader used the wrong precedence.',
        });
    });

    it('restores a prompt command invocation as the user request and drops built-in commands', () => {
        expect(
            extractAgentTitleMessage({
                type: 'user',
                message: {
                    content:
                        '<command-message>add-model</command-message>\n<command-name>/add-model</command-name>\n<command-args>gpt 6 sol/luna</command-args>',
                },
            }),
        ).toEqual({ isChunk: false, role: 'user', text: '/add-model gpt 6 sol/luna' });
        expect(
            extractAgentTitleMessage({
                type: 'user',
                message: {
                    content:
                        '<command-message>commit</command-message>\n<command-name>/commit</command-name>',
                },
            }),
        ).toEqual({ isChunk: false, role: 'user', text: '/commit' });
        expect(
            extractAgentTitleMessage({
                type: 'user',
                message: {
                    content:
                        '<command-name>/effort</command-name>\n            <command-message>effort</command-message>\n            <command-args>high</command-args>',
                },
            }),
        ).toBeUndefined();
        expect(
            extractAgentTitleMessage({
                type: 'user',
                message: {
                    content: '<local-command-stdout>Set effort level</local-command-stdout>',
                },
            }),
        ).toBeUndefined();
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

    it('uses the user request language despite English technical identifiers', () => {
        const context = {
            opening: [
                { role: 'user' as const, text: '修复 TASK-1234 的 Session 标题' },
                { role: 'assistant' as const, text: 'I will inspect the Session title.' },
            ],
            recent: [],
        };
        expect(buildAgentTitlePrompt(context)).toContain(
            '<title_language>Chinese</title_language>',
        );
        expect(normalizeGeneratedAgentTitle('Fix Session title', context)).toBeUndefined();
        expect(normalizeGeneratedAgentTitle('修复会话标题', context)).toBe('修复会话标题');
    });

    it('uses the assistant reply for language when the request is only an issue reference', () => {
        const context = {
            opening: [
                { role: 'user' as const, text: 'TASK-1234' },
                { role: 'assistant' as const, text: '需要修复会话标题同步。' },
            ],
            recent: [],
        };
        expect(buildAgentTitlePrompt(context)).toContain(
            '<title_language>Chinese</title_language>',
        );
        expect(normalizeGeneratedAgentTitle('TASK-1234', context)).toBeUndefined();
        expect(normalizeGeneratedAgentTitle('会话标题同步', context)).toBe('会话标题同步');
    });

    it('keeps the opening issue explanation language after an English follow-up command', () => {
        const context = {
            opening: [
                { role: 'user' as const, text: 'TASK-1234' },
                { role: 'assistant' as const, text: '需要修复会话标题同步。' },
            ],
            recent: [{ role: 'user' as const, text: 'commit' }],
        };
        expect(buildAgentTitlePrompt(context)).toContain(
            '<title_language>Chinese</title_language>',
        );
    });

    it('ignores image placeholders when choosing the conversation language', () => {
        const context = {
            opening: [
                { role: 'user' as const, text: '[Image #1]' },
                { role: 'assistant' as const, text: '需要修复菜单标题。' },
            ],
            recent: [],
        };
        expect(buildAgentTitlePrompt(context)).toContain(
            '<title_language>Chinese</title_language>',
        );
    });

    it('keeps English requests with model identifiers in English', () => {
        const context = {
            opening: [
                { role: 'user' as const, text: 'Fix GPT-600 routing' },
                { role: 'assistant' as const, text: 'The model route is missing.' },
            ],
            recent: [],
        };
        expect(buildAgentTitlePrompt(context)).toContain('<title_language>Latin</title_language>');
        expect(normalizeGeneratedAgentTitle('Fix GPT-600 routing', context)).toBe(
            'Fix GPT-600 routing',
        );
        expect(normalizeGeneratedAgentTitle('修复模型路由', context)).toBeUndefined();
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
            codexUser('https://linear.app/example/issue/TASK-24683/service-channel-errors'),
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
                text: 'https://linear.app/example/issue/TASK-24683/service-channel-errors',
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

    it('reads a Grok streaming turn as one message instead of many fragments', async () => {
        const grokChunk = (sessionUpdate: string, text: string): string =>
            JSON.stringify({
                method: 'session/update',
                params: { update: { sessionUpdate, content: { type: 'text', text } } },
            });
        const location = await writeTranscript([
            grokChunk('user_message_chunk', 'rename the '),
            grokChunk('user_message_chunk', 'selected Session'),
            grokChunk('agent_message_chunk', 'Renamed it '),
            grokChunk('agent_message_chunk', 'to Session titles.'),
        ]);
        const context = await readAgentTitleMessages(location);
        expect(context.opening).toEqual([
            { role: 'user', text: 'rename the selected Session' },
            { role: 'assistant', text: 'Renamed it to Session titles.' },
        ]);
        expect(context.recent).toEqual([]);
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

describe('Session title split-window scanning', () => {
    const message = (role: 'assistant' | 'user', text: string): string =>
        JSON.stringify({
            type: 'response_item',
            payload: {
                type: 'message',
                role,
                content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
            },
        });
    const toolNoise = (bytes: number): string =>
        JSON.stringify({
            type: 'response_item',
            payload: { type: 'function_call_output', output: 'x'.repeat(bytes) },
        });
    /**
     * Roughly 9MB, so two of them push the transcript past the scan budget and split the windows apart.
     */
    const filler = `${toolNoise(200_000)}\n`.repeat(45);

    /**
     * A transcript past the scan budget is read as an opening window plus a tail window. Only a real oversized file
     * exercises the mid-record range start, the fragment drop that follows it, and the window split itself.
     */
    async function writeOversizedTranscript(
        lines: readonly string[],
    ): Promise<AgentTranscriptLocation> {
        const baseRoot = await mkdtemp(join(tmpdir(), 'caxri-title-split-'));
        const root = join(baseRoot, 'project');
        await mkdir(root);
        const path = join(root, 'transcript.jsonl');
        await writeFile(path, lines.join(''), 'utf8');
        expect((await stat(path)).size).toBeGreaterThan(16 * 1024 * 1024);
        return { baseRoot, path, root };
    }

    it('takes the opening from the first window and never lets it fill the latest exchange', async () => {
        const location = await writeOversizedTranscript([
            `${message('user', 'investigate the circuit breaker alert')}\n`,
            `${message('assistant', 'checking the upstream channel now')}\n`,
            `${message('assistant', 'still inside the opening window')}\n`,
            filler,
            `${message('assistant', 'the breaker entries already cleared')}\n`,
            filler,
            `${message('user', 'just cancel')}\n`,
            `${message('assistant', 'moved it to canceled')}\n`,
        ]);
        const context = await readAgentTitleMessages(location);
        expect(context.opening.map((entry) => entry.text)).toEqual([
            'investigate the circuit breaker alert',
            'checking the upstream channel now',
        ]);
        /**
         * The middle message sits inside the tail window, so the window reaches back past the last exchange. The
         * opening window's third message does not, even though it was scanned.
         */
        expect(context.recent.map((entry) => entry.text)).toEqual([
            'the breaker entries already cleared',
            'just cancel',
            'moved it to canceled',
        ]);
        await rm(location.baseRoot, { force: true, recursive: true });
    });

    it('reports no opening rather than promoting the tail when the first window holds no request', async () => {
        const location = await writeOversizedTranscript([
            `${message('assistant', 'resumed from a previous thread')}\n`,
            filler,
            filler,
            `${message('user', 'just cancel')}\n`,
            `${message('assistant', 'moved it to canceled')}\n`,
        ]);
        const context = await readAgentTitleMessages(location);
        expect(context.opening).toEqual([]);
        expect(context.recent.map((entry) => entry.text)).toEqual([
            'just cancel',
            'moved it to canceled',
        ]);
        await rm(location.baseRoot, { force: true, recursive: true });
    });
});

describe('Session title ordering', () => {
    const message = (role: 'assistant' | 'user', text: string): string =>
        JSON.stringify({
            type: 'response_item',
            payload: {
                type: 'message',
                role,
                content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
            },
        });

    it('excludes assistant output that precedes the opening request from the latest exchange', async () => {
        const baseRoot = await mkdtemp(join(tmpdir(), 'caxri-title-order-'));
        const root = join(baseRoot, 'project');
        await mkdir(root);
        const path = join(root, 'transcript.jsonl');
        await writeFile(
            path,
            `${[
                message('assistant', 'resumed from a previous thread'),
                message('assistant', 'restoring the worktree lease'),
                message('user', 'investigate the alert'),
                message('assistant', 'checking it now'),
                message('user', 'just cancel'),
            ].join('\n')}\n`,
            'utf8',
        );
        const context = await readAgentTitleMessages({ baseRoot, path, root });
        expect(context.opening.map((entry) => entry.text)).toEqual([
            'investigate the alert',
            'checking it now',
        ]);
        expect(context.recent.map((entry) => entry.text)).toEqual(['just cancel']);
        await rm(baseRoot, { force: true, recursive: true });
    });
});
