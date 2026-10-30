import { MAX_AGENT_CHAT_DIFF_LENGTH, MAX_AGENT_CHAT_FILE_CHANGE_DIFF_TOTAL } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { closeDanglingItem } from '../../../chat-items';
import { CodexComputerUseBindings } from '../computer-use';
import {
    codexAgentName,
    codexRequestKey,
    mapCodexErrorNotice,
    mapCodexItem,
    mapCodexRequest,
} from '../items';

describe('Codex item mapping', () => {
    it('maps conversation and tool items into bounded Chat items', () => {
        expect(
            mapCodexItem(
                {
                    type: 'userMessage',
                    id: 'u',
                    content: [{ type: 'text', text: 'hi', text_elements: [] }],
                },
                't',
                false,
            ),
        ).toEqual({ id: 'u', turnId: 't', type: 'userMessage', text: 'hi' });
        expect(
            mapCodexItem(
                {
                    type: 'commandExecution',
                    id: 'c',
                    command: 'ls',
                    status: 'inProgress',
                    aggregatedOutput: null,
                    exitCode: null,
                },
                't',
                true,
            ),
        ).toEqual({
            id: 'c',
            turnId: 't',
            type: 'command',
            command: 'ls',
            status: 'running',
            output: '',
        });
        expect(
            mapCodexItem(
                {
                    type: 'fileChange',
                    id: 'f',
                    status: 'completed',
                    changes: [
                        { path: 'a.ts', kind: { type: 'update', move_path: null }, diff: '@@' },
                    ],
                },
                undefined,
                false,
            ),
        ).toEqual({
            id: 'f',
            type: 'fileChange',
            status: 'completed',
            changes: [{ path: 'a.ts', kind: 'update', diff: '@@' }],
        });
        expect(
            mapCodexItem(
                {
                    type: 'mcpToolCall',
                    id: 'm',
                    server: 'docs',
                    tool: 'search',
                    status: 'failed',
                    arguments: { q: 'x' },
                    error: { message: 'boom' },
                },
                't',
                false,
            ),
        ).toMatchObject({
            type: 'toolCall',
            name: 'docs/search',
            summary: '{"q":"x"}',
            output: 'boom',
        });
    });

    it('titles a Computer Use step by its title and names the surface it drove', () => {
        const step = (result: unknown) =>
            mapCodexItem(
                {
                    type: 'mcpToolCall',
                    id: 'c',
                    server: 'cua_repl',
                    tool: 'js',
                    status: 'completed',
                    arguments: { code: 'await tab.getAXState();', title: 'Check the sign-in' },
                    result,
                },
                't',
                false,
            );
        const browserResult = {
            content: [{ type: 'text', text: 'Browser tab: 1' }],
            _meta: { 'codex/toolSurface': { kind: 'browserUse', backend: 'chrome' } },
        };
        expect(step(browserResult)).toMatchObject({
            type: 'toolCall',
            name: 'browserUse',
            summary: 'Check the sign-in',
            input: 'await tab.getAXState();',
            output: 'Browser tab: 1',
        });
        // A step that returned its whole result again as text reads through to the inner output.
        expect(
            step({ content: [{ type: 'text', text: JSON.stringify(browserResult) }] }),
        ).toMatchObject({ name: 'browserUse', output: 'Browser tab: 1' });
        expect(
            step({
                content: [{ type: 'text', text: 'Clicked' }],
                _meta: { 'codex/toolSurface': { kind: 'computerUse', app: null } },
            }),
        ).toMatchObject({ name: 'computerUse', output: 'Clicked' });
    });

    it('names a running browser step by the browser API its script calls, before any result', () => {
        const bindings = new CodexComputerUseBindings();
        const running = (code: string) =>
            mapCodexItem(
                {
                    type: 'mcpToolCall',
                    id: 'c',
                    server: 'cua_repl',
                    tool: 'js',
                    status: 'inProgress',
                    arguments: { code, title: 'Step' },
                },
                't',
                true,
                bindings,
            );
        expect(running(`let routerTab = await cua.getTab('7', { browser: '1' });`)).toMatchObject({
            name: 'browserUse',
            status: 'running',
        });
        expect(
            running(`await cua.createBrowserTab('chrome', 'https://example.com/');`),
        ).toMatchObject({ name: 'browserUse' });
        // The REPL keeps variables across steps, so a later step that only drives the bound tab stays a browser step.
        expect(running('await routerTab.click(12); await routerTab.getAXState();')).toMatchObject({
            name: 'browserUse',
        });
        expect(running(`let finder = await cua.getApp('com.apple.finder');`)).toMatchObject({
            name: 'computerUse',
        });
        expect(running('await finder.pressKey("Return");')).toMatchObject({ name: 'computerUse' });
        // Nothing in the script names a surface: the step keeps the Computer Use default.
        expect(running('await cua.getState();')).toMatchObject({ name: 'computerUse' });
        // A settled step still trusts the surface Codex reported over the script.
        expect(
            mapCodexItem(
                {
                    type: 'mcpToolCall',
                    id: 'c',
                    server: 'cua_repl',
                    tool: 'js',
                    status: 'completed',
                    arguments: { code: 'await routerTab.getAXState();', title: 'Step' },
                    result: {
                        content: [{ type: 'text', text: 'Clicked' }],
                        _meta: { 'codex/toolSurface': { kind: 'computerUse' } },
                    },
                },
                't',
                false,
                bindings,
            ),
        ).toMatchObject({ name: 'computerUse' });
    });

    it('summarizes a dynamic tool by a readable field instead of its raw JSON arguments', () => {
        const summary = (arguments_: unknown) => {
            const item = mapCodexItem(
                {
                    type: 'dynamicToolCall',
                    id: 'd',
                    tool: 'notify',
                    status: 'completed',
                    arguments: arguments_,
                },
                't',
                false,
            );
            return item?.type === 'toolCall' ? item.summary : undefined;
        };
        expect(summary({ channel: 'ops', title: 'Deploy finished' })).toBe('Deploy finished');
        expect(summary({ count: 3, nested: { a: 1 } })).toBe('count: 3');
        expect(summary({ nested: { a: 1 } })).toBeUndefined();
        expect(summary('plain text')).toBe('plain text');
    });

    it("keeps a dynamic tool call's JSON arguments beside its readable summary", () => {
        expect(
            mapCodexItem(
                {
                    type: 'dynamicToolCall',
                    id: 'd',
                    tool: 'notify',
                    status: 'completed',
                    arguments: { channel: 'ops', title: 'Deploy finished' },
                },
                't',
                false,
            ),
        ).toMatchObject({
            summary: 'Deploy finished',
            input: '{"channel":"ops","title":"Deploy finished"}',
        });
    });

    it('shows a plan-mode plan as an Agent message', () => {
        expect(mapCodexItem({ type: 'plan', id: 'p', text: '1. Read' }, 't', false)).toMatchObject({
            id: 'p',
            turnId: 't',
            type: 'agentMessage',
            text: '1. Read',
            proposedPlan: true,
        });
    });

    it('marks only a plan item as a proposed plan', () => {
        expect(
            mapCodexItem({ type: 'agentMessage', id: 'm', text: 'Hi' }, 't', false),
        ).not.toHaveProperty('proposedPlan');
    });

    it('skips items that are not conversation content and malformed input', () => {
        expect(mapCodexItem({ type: 'agentMessage' }, 't', false)).toBeUndefined();
        expect(mapCodexItem('nope', 't', false)).toBeUndefined();
    });

    it('shows a compaction notice only once compaction completed', () => {
        const compaction = { type: 'contextCompaction', id: 'k' };
        expect(mapCodexItem(compaction, 't', true)).toBeUndefined();
        expect(mapCodexItem(compaction, 't', false)).toEqual({
            id: 'k',
            turnId: 't',
            type: 'notice',
            kind: 'compacted',
        });
    });

    it('maps subagent tool calls into readable tool rows', () => {
        expect(
            mapCodexItem(
                {
                    type: 'collabAgentToolCall',
                    id: 's',
                    tool: 'spawnAgent',
                    status: 'inProgress',
                    senderThreadId: 'parent',
                    receiverThreadIds: [],
                    prompt: 'Find the bug',
                    model: null,
                    agentsStates: {},
                },
                't',
                true,
            ),
        ).toEqual({
            id: 's',
            turnId: 't',
            type: 'toolCall',
            name: 'spawnAgent',
            status: 'running',
            summary: 'Find the bug',
        });
        expect(
            mapCodexItem(
                {
                    type: 'collabAgentToolCall',
                    id: 'w',
                    tool: 'wait',
                    status: 'interrupted',
                    senderThreadId: 'parent',
                    receiverThreadIds: ['a', 'b'],
                    prompt: null,
                    agentsStates: {
                        a: { status: 'completed', message: 'Done.' },
                        b: { status: 'running', message: null },
                    },
                },
                't',
                false,
            ),
        ).toMatchObject({
            name: 'wait',
            status: 'interrupted',
            summary: '2 agents',
            output: 'Done.',
        });
        // With the subagents' names known, the wait says whom it waits for; one unnamed receiver keeps the count.
        const wait = {
            type: 'collabAgentToolCall',
            id: 'w',
            tool: 'wait',
            status: 'inProgress',
            receiverThreadIds: ['a', 'b'],
            prompt: null,
        };
        const names = new Map([
            ['a', 'Find the bug'],
            ['b', 'Lint'],
        ]);
        expect(mapCodexItem(wait, 't', true, undefined, (id) => names.get(id))).toMatchObject({
            summary: 'Find the bug, Lint',
        });
        expect(
            mapCodexItem(wait, 't', true, undefined, (id) =>
                id === 'a' ? 'Find the bug' : undefined,
            ),
        ).toMatchObject({ summary: '2 agents' });
        expect(
            mapCodexItem(
                {
                    type: 'subAgentActivity',
                    id: 'v',
                    kind: 'started',
                    agentThreadId: 'child',
                    agentPath: '/root/reviewer',
                    model: null,
                },
                't',
                false,
            ),
        ).toMatchObject({ type: 'toolCall', name: 'spawnAgent', summary: 'reviewer' });
    });

    it('names a subagent by the last segment of its agent path', () => {
        expect(codexAgentName('/root/watch_pr_retry', 1_000)).toBe('watch_pr_retry');
        expect(codexAgentName('/root/planner/reviewer/', 1_000)).toBe('reviewer');
        expect(codexAgentName('/', 1_000)).toBeUndefined();
        expect(codexAgentName(undefined, 1_000)).toBeUndefined();
    });

    it('closes items a turn left open', () => {
        expect(
            closeDanglingItem({
                id: 'c',
                type: 'command',
                command: 'x',
                status: 'running',
                output: '',
            }),
        ).toMatchObject({ status: 'interrupted' });
        expect(
            closeDanglingItem({ id: 'a', type: 'agentMessage', text: 'x', streaming: true }),
        ).toMatchObject({ streaming: false });
        expect(
            closeDanglingItem({
                id: 'c',
                type: 'command',
                command: 'x',
                status: 'completed',
                output: '',
            }),
        ).toBeUndefined();
    });

    it('keys a request by its approval callback before its item', () => {
        expect(codexRequestKey({ itemId: 'item', approvalId: 'approval' })).toBe('approval');
        expect(codexRequestKey({ itemId: 'item', approvalId: null })).toBe('item');
        expect(codexRequestKey({})).toBeUndefined();
    });

    it('keeps the approval context Codex sends and only the decisions Caxri can offer', () => {
        expect(
            mapCodexRequest('command', 'r', {
                itemId: 'cmd-1',
                reason: 'Needs the network',
                command: 'curl example.com',
                cwd: '/work',
                networkApprovalContext: { host: 'example.com', protocol: 'https' },
                availableDecisions: [
                    'accept',
                    'decline',
                    'accept',
                    { acceptWithExecpolicyAmendment: { execpolicy_amendment: [] } },
                ],
            }),
        ).toEqual({
            id: 'r',
            kind: 'command',
            itemId: 'cmd-1',
            reason: 'Needs the network',
            command: 'curl example.com',
            cwd: '/work',
            networkHost: 'example.com',
            decisions: ['accept', 'decline'],
        });
        // Codex's default command approval lists `cancel` but not `decline`; declining still answers it, so it stays.
        expect(
            mapCodexRequest('command', 'd', {
                command: 'git push --force',
                availableDecisions: [
                    'accept',
                    { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', 'push'] } },
                    'cancel',
                ],
            }),
        ).toEqual({
            id: 'd',
            kind: 'command',
            command: 'git push --force',
            decisions: ['accept', 'cancel', 'decline', 'acceptAlways'],
            alwaysAllowPrefix: 'git push',
        });
        // The top-level proposal fills in when the listed amendment is unusable; a network approval has none.
        expect(
            mapCodexRequest('command', 'p', {
                proposedExecpolicyAmendment: ['npm', 'test'],
                availableDecisions: [
                    'accept',
                    { acceptWithExecpolicyAmendment: { execpolicy_amendment: [] } },
                ],
            }),
        ).toMatchObject({ decisions: ['accept', 'acceptAlways'], alwaysAllowPrefix: 'npm test' });
        expect(
            mapCodexRequest('command', 'n', {
                networkApprovalContext: { host: 'example.com' },
                availableDecisions: [
                    'accept',
                    { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['curl'] } },
                ],
            }),
        ).not.toHaveProperty('alwaysAllowPrefix');
        // No list, or a list with nothing Caxri can offer, means every plain decision applies.
        expect(mapCodexRequest('fileChange', 'f', { availableDecisions: [{ other: 1 }] })).toEqual({
            id: 'f',
            kind: 'fileChange',
        });
    });

    it('maps questions with their options', () => {
        expect(
            mapCodexRequest('question', 'q', {
                questions: [
                    {
                        id: 'color',
                        header: 'Color',
                        question: 'Which?',
                        isOther: true,
                        options: [{ label: 'Red', description: 'Warm' }],
                    },
                    { header: 'missing id' },
                ],
            }),
        ).toEqual({
            id: 'q',
            kind: 'question',
            questions: [
                {
                    id: 'color',
                    header: 'Color',
                    question: 'Which?',
                    options: [{ label: 'Red', description: 'Warm' }],
                    allowsOther: true,
                },
            ],
        });
    });

    it("bounds the sum of one file-change item's diffs", () => {
        const count =
            Math.ceil(MAX_AGENT_CHAT_FILE_CHANGE_DIFF_TOTAL / MAX_AGENT_CHAT_DIFF_LENGTH) + 3;
        const item = mapCodexItem(
            {
                id: 'patch',
                type: 'fileChange',
                status: 'completed',
                changes: Array.from({ length: count }, (_, index) => ({
                    path: `file-${index}.ts`,
                    kind: { type: 'update' },
                    diff: 'd'.repeat(MAX_AGENT_CHAT_DIFF_LENGTH),
                })),
            },
            'turn',
            false,
        );
        if (item?.type !== 'fileChange') throw new Error('expected a file-change item');
        const total = item.changes.reduce((sum, change) => sum + change.diff.length, 0);
        expect(total).toBe(MAX_AGENT_CHAT_FILE_CHANGE_DIFF_TOTAL);
        // Every path is still listed, so the user sees what changed even when a diff is cut.
        expect(item.changes).toHaveLength(count);
        expect(item.changes.at(-1)?.diff).toBe('');
        // The cut is marked wherever it lands, so the pane never presents a partial patch as the whole change.
        expect(item.changes.at(0)?.truncated).toBeUndefined();
        expect(item.changes.at(-1)?.truncated).toBe(true);
    });

    it('marks a single oversized diff as truncated and leaves a whole one unmarked', () => {
        const item = mapCodexItem(
            {
                id: 'patch',
                type: 'fileChange',
                status: 'completed',
                changes: [
                    {
                        path: 'big.ts',
                        kind: { type: 'update', move_path: null },
                        diff: 'd'.repeat(MAX_AGENT_CHAT_DIFF_LENGTH + 1),
                    },
                    {
                        path: 'small.ts',
                        kind: { type: 'add' },
                        diff: 'one line\n',
                    },
                ],
            },
            'turn',
            false,
        );
        if (item?.type !== 'fileChange') throw new Error('expected a file-change item');
        expect(item.changes).toEqual([
            {
                path: 'big.ts',
                kind: 'update',
                diff: 'd'.repeat(MAX_AGENT_CHAT_DIFF_LENGTH),
                truncated: true,
            },
            { path: 'small.ts', kind: 'add', diff: 'one line\n' },
        ]);
    });
});

describe('Codex error notices', () => {
    it('reads a retry as its cause and attempt, keeping the failure as the detail', () => {
        expect(
            mapCodexErrorNotice(
                {
                    willRetry: true,
                    error: {
                        message: 'Reconnecting... 2/5',
                        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
                        additionalDetails: 'stream disconnected before completion',
                    },
                },
                'turn-1',
            ),
        ).toEqual({
            id: 'turn-1:retrying',
            turnId: 'turn-1',
            type: 'notice',
            kind: 'retrying',
            retry: { cause: 'connection', attempt: 2, maxAttempts: 5 },
            message: 'stream disconnected before completion',
        });
        expect(
            mapCodexErrorNotice(
                { willRetry: true, error: { message: 'Busy', codexErrorInfo: 'serverOverloaded' } },
                undefined,
            ),
        ).toMatchObject({ retry: { cause: 'overloaded' }, message: 'Busy' });
    });

    it('keeps a final error as the provider reported it', () => {
        expect(
            mapCodexErrorNotice({ willRetry: false, error: { message: 'Failed' } }, 'turn-1'),
        ).toEqual({
            id: 'turn-1:error',
            turnId: 'turn-1',
            type: 'notice',
            kind: 'error',
            message: 'Failed',
        });
    });
});
