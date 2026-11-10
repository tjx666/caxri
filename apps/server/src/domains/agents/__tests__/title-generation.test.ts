import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
    buildAgentTitlePrompt,
    extractAgentTitleMessage,
    hasTitleNamingMaterial,
    normalizeGeneratedAgentTitle,
    readAgentTitleMessages,
    requiredAgentTitleLanguage,
    sampleAgentTitle,
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
                    content:
                        '<command-name>/goal</command-name>\n            <command-message>goal</command-message>\n            <command-args>Close stale issues\n\n- stop by 9am</command-args>',
                },
            }),
        ).toEqual({
            isChunk: false,
            role: 'user',
            text: '/goal Close stale issues\n\n- stop by 9am',
        });
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

    it('rejects a title too wide for the sidebar or listing several changes', () => {
        for (const title of [
            '导出按钮改为下拉菜单，添加历史记录入口，空列表时隐藏工具栏',
            '导出按钮下拉菜单与历史记录入口及空列表工具栏隐藏调整',
            'Export menu redesign with history entry and empty-list toolbar',
            'Export menu, history entry',
            '导出菜单；历史入口',
        ])
            expect(normalizeGeneratedAgentTitle(title)).toBeUndefined();
        expect(normalizeGeneratedAgentTitle('导出按钮改为下拉菜单')).toBe('导出按钮改为下拉菜单');
        expect(normalizeGeneratedAgentTitle('二十个汉字可以放进侧边栏里的会话标题长度')).toBe(
            '二十个汉字可以放进侧边栏里的会话标题长度',
        );
        expect(normalizeGeneratedAgentTitle('Export button becomes a dropdown menu')).toBe(
            'Export button becomes a dropdown menu',
        );
    });

    it('rejects a colon, a labelled answer and kana mixed into a Chinese title', () => {
        const context = {
            opening: [
                { role: 'user' as const, text: '<image> 他最后说的啥' },
                { role: 'assistant' as const, text: '他撤回了之前的决定' },
            ],
            recent: [],
        };
        for (const title of [
            'Chinese title: 默认请求模式讨论',
            '标题如下：默认请求模式讨论',
            '会话标题：默认请求模式讨论',
            '对话标题: 默认请求模式讨论',
            'Session title: 默认请求模式讨论',
            '修复会话标题：前缀残留',
            '设置页改版：合并通知开关',
            '磁吧ぶ',
        ])
            expect(normalizeGeneratedAgentTitle(title, context)).toBeUndefined();
        expect(normalizeGeneratedAgentTitle('默认请求模式讨论', context)).toBe('默认请求模式讨论');
        expect(normalizeGeneratedAgentTitle('Fix: Session title sync')).toBeUndefined();
    });

    it('rejects a sentence that describes the request instead of naming it', () => {
        const context = {
            opening: [{ role: 'user' as const, text: '<image>现在是怎么邀请企业客户的' }],
            recent: [],
        };
        for (const title of [
            '该问题的主题是询问当前邀请企业客户的方式。',
            '该问题的主题是询问当前邀请企业客户的方式',
            '用户在询问如何邀请企业客户',
            '这个会话讨论企业客户邀请流程',
            '企业客户邀请方式。',
            '企业客户怎么邀请？',
        ])
            expect(normalizeGeneratedAgentTitle(title, context)).toBeUndefined();
        expect(normalizeGeneratedAgentTitle('企业客户邀请方式', context)).toBe('企业客户邀请方式');
        for (const title of [
            'The user asks how enterprise customers are invited',
            'This session is about invite flows',
            'Enterprise customer invites.',
        ])
            expect(normalizeGeneratedAgentTitle(title)).toBeUndefined();
        expect(normalizeGeneratedAgentTitle('Enterprise customer invites')).toBe(
            'Enterprise customer invites',
        );
        expect(normalizeGeneratedAgentTitle('Upgrade to Node.js')).toBe('Upgrade to Node.js');
        expect(normalizeGeneratedAgentTitle('Fix user question parsing')).toBe(
            'Fix user question parsing',
        );
    });
});

describe('Session title sampling', () => {
    const context = {
        opening: [
            { role: 'user' as const, text: '<image>' },
            { role: 'assistant' as const, text: 'The request decides the default transport' },
        ],
        recent: [],
    };

    it('re-samples a SKIP up to the allowed number of times', async () => {
        const generate = vi
            .fn<(prompt: string) => Promise<string>>()
            .mockResolvedValueOnce('SKIP')
            .mockResolvedValueOnce('SKIP')
            .mockResolvedValue('Default transport decision');
        await expect(sampleAgentTitle({ context, generate, skipRetries: 2 })).resolves.toEqual({
            title: 'Default transport decision',
        });
        expect(generate).toHaveBeenCalledTimes(3);
        expect(generate.mock.calls.every(([prompt]) => !prompt.includes('<retry>'))).toBe(true);
    });

    it('keeps a SKIP final when no re-sample is allowed', async () => {
        const generate = vi.fn<(prompt: string) => Promise<string>>().mockResolvedValue('SKIP');
        await expect(sampleAgentTitle({ context, generate, skipRetries: 0 })).resolves.toEqual({
            reason: 'skipped',
        });
        expect(generate).toHaveBeenCalledOnce();
    });

    it('gives an invalid answer one corrective retry and reports it as rejected', async () => {
        const generate = vi
            .fn<(prompt: string) => Promise<string>>()
            .mockResolvedValue('x'.repeat(81));
        await expect(sampleAgentTitle({ context, generate, skipRetries: 2 })).resolves.toEqual({
            reason: 'rejected',
        });
        expect(generate).toHaveBeenCalledTimes(2);
        expect(generate.mock.calls[1]?.[0]).toContain('<retry>');
    });

    it('stops as soon as the caller is no longer eligible', async () => {
        const generate = vi.fn<(prompt: string) => Promise<string>>().mockResolvedValue('SKIP');
        await expect(
            sampleAgentTitle({ context, generate, skipRetries: 2, shouldContinue: () => false }),
        ).resolves.toEqual({ reason: 'abandoned' });
        expect(generate).toHaveBeenCalledOnce();
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

    it('keeps an image-only Claude request so the completed turn can name the Session from the reply', async () => {
        const image = {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
        };
        const location = await writeTranscript([
            JSON.stringify({ type: 'user', message: { role: 'user', content: [image] } }),
            JSON.stringify({
                type: 'user',
                isMeta: true,
                message: {
                    role: 'user',
                    content: [{ type: 'text', text: '[Image: source: /tmp/1.png]' }],
                },
            }),
            JSON.stringify({
                type: 'user',
                message: { role: 'user', content: [{ type: 'tool_result', content: [image] }] },
            }),
            JSON.stringify({
                type: 'assistant',
                message: {
                    role: 'assistant',
                    content: [{ type: 'text', text: '截图里的会话标题一直是未命名。' }],
                },
            }),
        ]);
        const context = await readAgentTitleMessages(location);
        expect(context.opening).toEqual([
            { role: 'user', text: '<image>' },
            { role: 'assistant', text: '截图里的会话标题一直是未命名。' },
        ]);
        expect(hasTitleNamingMaterial(context)).toBe(true);
        expect(buildAgentTitlePrompt(context)).toContain(
            '<title_language>Chinese</title_language>',
        );
        await rm(location.baseRoot, { force: true, recursive: true });
    });

    it('keeps an image-only Codex request as the opening request', () => {
        expect(
            extractAgentTitleMessage({
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }],
                },
            }),
        ).toEqual({ isChunk: false, role: 'user', text: '<image>' });
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

describe('Agent-chosen Session title language', () => {
    it("requires the script of the creating Session's title", () => {
        expect(requiredAgentTitleLanguage('Delegated task: schema tests', '排查 CI 耗时')).toBe(
            'Chinese',
        );
        expect(requiredAgentTitleLanguage('补充 schema 测试', '排查 CI 耗时')).toBeUndefined();
        expect(requiredAgentTitleLanguage('Fix login', 'ログイン修正')).toBe('Japanese');
        expect(requiredAgentTitleLanguage('Fix login', '로그인 수정')).toBe('Korean');
    });

    it('imposes nothing for a Latin, unnamed, or missing reference', () => {
        expect(requiredAgentTitleLanguage('Fix login', 'Investigate CI')).toBeUndefined();
        expect(requiredAgentTitleLanguage('Fix login', 'Untitled')).toBeUndefined();
        expect(requiredAgentTitleLanguage('Fix login', undefined)).toBeUndefined();
    });
});
