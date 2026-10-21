import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentEnvironment } from '../contract';
import { listExternalConversations } from '../external-conversations';
import { claudeTranscriptRoot } from '../providers/claude/paths';
import { encodeGrokCwdDirname } from '../providers/grok/paths';

const NOW = Date.parse('2026-05-01T12:00:00Z');
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const PROJECT = '/workspace/demo-app';

describe('listExternalConversations', () => {
    let home: string;
    let environment: AgentEnvironment;

    beforeEach(async () => {
        home = await mkdtemp(join(tmpdir(), 'caxri-external-conversations-'));
        environment = { homeDirectory: home, variables: {} };
    });

    afterEach(async () => {
        await rm(home, { force: true, recursive: true });
    });

    async function writeLines(path: string, records: unknown[], updatedAt: number): Promise<void> {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
        await utimes(path, updatedAt / 1000, updatedAt / 1000);
    }

    function list(overrides: Partial<Parameters<typeof listExternalConversations>[0]> = {}) {
        return listExternalConversations({
            environment,
            excludeProviderSessionIds: new Set(),
            now: NOW,
            ...overrides,
        });
    }

    // Claude Code: `projects/<encoded cwd>/<session id>.jsonl`.

    const claudeUser = (
        sessionId: string,
        content: unknown,
        extra: Record<string, unknown> = {},
    ) => ({
        type: 'user',
        cwd: PROJECT,
        entrypoint: 'cli',
        isSidechain: false,
        sessionId,
        uuid: `${sessionId}-u`,
        message: { role: 'user', content },
        ...extra,
    });

    function claudePath(sessionId: string, cwd = PROJECT): string {
        return join(claudeTranscriptRoot(join(home, '.claude'), cwd), `${sessionId}.jsonl`);
    }

    // Codex: `sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl`.

    const CODEX_THREAD = '01990000-0000-7000-8000-000000000001';

    const codexMeta = (id: string, source: unknown = 'cli') => ({
        type: 'session_meta',
        payload: { id, cwd: PROJECT, source, originator: 'codex_cli_rs' },
    });
    const codexMessage = (role: string, text: string) => ({
        type: 'response_item',
        payload: {
            type: 'message',
            role,
            content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
        },
    });

    function codexPath(threadId: string, suffix = ''): string {
        return join(
            home,
            '.codex/sessions/2026/04/20',
            `rollout-2026-04-20T09-00-00-${threadId}${suffix}.jsonl`,
        );
    }

    // Grok Build: `sessions/<encoded cwd>/<session id>/{summary.json,updates.jsonl}`.

    const grokChunk = (sessionId: string, kind: string, text: string) => ({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId, update: { sessionUpdate: kind, content: { type: 'text', text } } },
    });

    async function writeGrok(
        sessionId: string,
        summary: Record<string, unknown>,
        updates: unknown[],
        updatedAt: number,
    ): Promise<void> {
        const root = join(home, '.grok/sessions', encodeGrokCwdDirname(PROJECT), sessionId);
        await mkdir(root, { recursive: true });
        await writeFile(join(root, 'summary.json'), JSON.stringify(summary));
        await writeLines(join(root, 'updates.jsonl'), updates, updatedAt);
    }

    it('reads a Claude conversation, preferring the /rename title over the generated one', async () => {
        await writeLines(
            claudePath('claude-renamed'),
            [
                { type: 'permission-mode', permissionMode: 'default', sessionId: 'claude-renamed' },
                claudeUser('claude-renamed', 'Caveat', { isMeta: true }),
                claudeUser(
                    'claude-renamed',
                    '<command-name>/clear</command-name><command-message>clear</command-message>',
                ),
                claudeUser('claude-renamed', [{ type: 'text', text: 'Fix the login form' }]),
                { type: 'ai-title', aiTitle: 'Login form fix', sessionId: 'claude-renamed' },
                { type: 'custom-title', customTitle: 'Auth cleanup', sessionId: 'claude-renamed' },
                { type: 'ai-title', aiTitle: 'Later generated title', sessionId: 'claude-renamed' },
            ],
            NOW - 10 * MINUTE,
        );
        await writeLines(
            claudePath('claude-prompt-only'),
            [
                claudeUser('claude-prompt-only', '<system-reminder>internal</system-reminder>'),
                claudeUser('claude-prompt-only', `Add\n  dark mode   ${'x'.repeat(200)}`),
            ],
            NOW - 30 * MINUTE,
        );

        const conversations = await list();

        expect(conversations).toEqual([
            {
                provider: 'claude',
                providerSessionId: 'claude-renamed',
                cwd: PROJECT,
                title: 'Auth cleanup',
                updatedAt: NOW - 10 * MINUTE,
                mayBeOpen: false,
            },
            expect.objectContaining({ providerSessionId: 'claude-prompt-only', cwd: PROJECT }),
        ]);
        const title = conversations[1]?.title ?? '';
        expect(title.startsWith('Add dark mode xxx')).toBe(true);
        expect([...title]).toHaveLength(120);
        expect(title.endsWith('…')).toBe(true);
    });

    it('skips Claude sidechains, SDK runs, subagent subtrees, delegations, and empty conversations', async () => {
        const at = NOW - 5 * MINUTE;
        const subagentPath = join(
            dirname(claudePath('claude-parent')),
            'claude-parent/subagents/agent-a1.jsonl',
        );
        await writeLines(
            claudePath('claude-sidechain'),
            [claudeUser('claude-sidechain', 'Search the code', { isSidechain: true })],
            at,
        );
        await writeLines(
            claudePath('claude-sdk'),
            [claudeUser('claude-sdk', 'Summarize', { entrypoint: 'sdk-cli' })],
            at,
        );
        await writeLines(
            claudePath('claude-hosted'),
            [claudeUser('claude-hosted', 'Draft a note', { entrypoint: 'sdk-ts' })],
            at,
        );
        await writeLines(subagentPath, [claudeUser('claude-parent', 'Sub task')], at);
        await writeLines(
            claudePath('claude-delegated'),
            [
                claudeUser(
                    'claude-delegated',
                    'Read the delegated task from "/workspace/.caxri/task-1.md" and carry it out. Delegation ID: d-1.',
                ),
            ],
            at,
        );
        await writeLines(
            claudePath('claude-empty'),
            [claudeUser('claude-empty', '<local-command-caveat>Caveat</local-command-caveat>')],
            at,
        );

        await expect(list()).resolves.toEqual([]);
    });

    it('reads Codex rollouts, skipping injected prompts, subagents, and exec runs', async () => {
        const subagent = '01990000-0000-7000-8000-000000000002';
        const exec = '01990000-0000-7000-8000-000000000003';
        await writeLines(
            codexPath(CODEX_THREAD),
            [
                codexMeta(CODEX_THREAD),
                codexMessage('developer', 'permissions'),
                codexMessage('user', '# AGENTS.md instructions for /workspace/demo-app\n...'),
                codexMessage('user', '<environment_context>\n  <cwd>/workspace</cwd>'),
                codexMessage('user', 'Refactor the cache layer'),
                codexMessage('assistant', 'Sure.'),
            ],
            NOW - DAY,
        );
        await writeLines(
            codexPath(subagent),
            [
                codexMeta(subagent, {
                    subagent: { thread_spawn: { parent_thread_id: CODEX_THREAD, depth: 1 } },
                }),
                codexMessage('user', 'Child task'),
            ],
            NOW - DAY,
        );
        await writeLines(
            codexPath(exec),
            [codexMeta(exec, 'exec'), codexMessage('user', 'One shot')],
            NOW - DAY,
        );

        await expect(list()).resolves.toEqual([
            {
                provider: 'codex',
                providerSessionId: CODEX_THREAD,
                cwd: PROJECT,
                title: 'Refactor the cache layer',
                updatedAt: NOW - DAY,
                mayBeOpen: false,
            },
        ]);
    });

    it("uses Codex's thread name and source, keeps a reverted thread's newest rollout, and applies the open probe", async () => {
        const revertedRollout = '01990000-0000-7000-8000-0000000000ff';
        await writeLines(
            codexPath(CODEX_THREAD),
            [codexMeta(CODEX_THREAD), codexMessage('user', 'Original prompt')],
            NOW - 3 * DAY,
        );
        await writeLines(
            codexPath(CODEX_THREAD, `_${revertedRollout}`),
            [codexMeta(CODEX_THREAD), codexMessage('user', 'Edited prompt')],
            NOW - 2 * DAY,
        );
        // The state database marks this thread a spawned subagent even though its rollout head looks interactive.
        const storedSubagent = '01990000-0000-7000-8000-000000000004';
        await writeLines(
            codexPath(storedSubagent),
            [codexMeta(storedSubagent), codexMessage('user', 'Child task')],
            NOW - DAY,
        );
        await mkdir(join(home, '.codex'), { recursive: true });
        const database = new Database(join(home, '.codex/state_5.sqlite'));
        database.exec(
            'CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, cwd TEXT, source TEXT)',
        );
        const insert = database.prepare(
            'INSERT INTO threads (id, name, cwd, source) VALUES (?, ?, ?, ?)',
        );
        insert.run(CODEX_THREAD, 'Cache refactor', PROJECT, 'cli');
        insert.run(storedSubagent, null, PROJECT, '{"subagent":"review"}');
        database.close();

        await expect(
            list({ openCodexSessionIds: () => Promise.resolve(new Set([CODEX_THREAD])) }),
        ).resolves.toEqual([
            {
                provider: 'codex',
                providerSessionId: CODEX_THREAD,
                cwd: PROJECT,
                title: 'Cache refactor',
                updatedAt: NOW - 2 * DAY,
                mayBeOpen: true,
            },
        ]);
    });

    it('reads Grok conversations from summary.json and joins a chunked first prompt', async () => {
        await writeGrok(
            'grok-titled',
            {
                info: { id: 'grok-titled', cwd: PROJECT },
                session_kind: null,
                generated_title: 'Plan the release',
            },
            [grokChunk('grok-titled', 'user_message_chunk', 'Plan')],
            NOW - MINUTE,
        );
        await writeGrok(
            'grok-untitled',
            { info: { id: 'grok-untitled', cwd: PROJECT }, session_kind: null },
            [
                {
                    method: '_x.ai/session/update',
                    params: {
                        sessionId: 'grok-untitled',
                        update: { sessionUpdate: 'hook_execution' },
                    },
                },
                grokChunk('grok-untitled', 'user_message_chunk', 'Write '),
                grokChunk('grok-untitled', 'user_message_chunk', 'the changelog'),
                grokChunk('grok-untitled', 'agent_message_chunk', 'Done'),
            ],
            NOW - 10 * MINUTE,
        );
        for (const kind of ['headless', 'subagent', 'subagent_resume'])
            // eslint-disable-next-line no-await-in-loop -- tiny sequential fixture setup
            await writeGrok(
                `grok-${kind}`,
                { info: { id: `grok-${kind}`, cwd: PROJECT }, session_kind: kind },
                [grokChunk(`grok-${kind}`, 'user_message_chunk', 'Hidden')],
                NOW - MINUTE,
            );

        await expect(list()).resolves.toEqual([
            {
                provider: 'grok',
                providerSessionId: 'grok-titled',
                cwd: PROJECT,
                title: 'Plan the release',
                updatedAt: NOW - MINUTE,
                mayBeOpen: true,
            },
            {
                provider: 'grok',
                providerSessionId: 'grok-untitled',
                cwd: PROJECT,
                title: 'Write the changelog',
                updatedAt: NOW - 10 * MINUTE,
                mayBeOpen: false,
            },
        ]);
    });

    it('orders across providers newest first and applies exclusion, age window, and limit', async () => {
        await writeLines(
            claudePath('claude-new'),
            [claudeUser('claude-new', 'Newest')],
            NOW - MINUTE,
        );
        await writeLines(
            claudePath('claude-bound'),
            [claudeUser('claude-bound', 'Already in Caxri')],
            NOW - 2 * MINUTE,
        );
        await writeLines(
            codexPath(CODEX_THREAD),
            [codexMeta(CODEX_THREAD), codexMessage('user', 'Middle')],
            NOW - 3 * MINUTE,
        );
        await writeGrok(
            'grok-older',
            { info: { id: 'grok-older', cwd: PROJECT }, session_kind: null },
            [grokChunk('grok-older', 'user_message_chunk', 'Older')],
            NOW - 4 * MINUTE,
        );
        await writeLines(
            claudePath('claude-stale'),
            [claudeUser('claude-stale', 'Too old')],
            NOW - 40 * DAY,
        );

        const ids = async (overrides: Parameters<typeof list>[0]) =>
            (await list(overrides)).map((conversation) => conversation.providerSessionId);
        const excludeProviderSessionIds = new Set(['claude-bound']);
        await expect(ids({ excludeProviderSessionIds })).resolves.toEqual([
            'claude-new',
            CODEX_THREAD,
            'grok-older',
        ]);
        await expect(ids({ excludeProviderSessionIds, limit: 2 })).resolves.toEqual([
            'claude-new',
            CODEX_THREAD,
        ]);
        await expect(ids({ excludeProviderSessionIds, maxAgeMs: 50 * DAY })).resolves.toContain(
            'claude-stale',
        );
    });

    it('returns an empty list when no provider store exists', async () => {
        await expect(list()).resolves.toEqual([]);
    });
});
