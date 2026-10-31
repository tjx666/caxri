import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { classifyConversationCandidate } from '../external-conversation-parsers';
import { claudeTranscriptRoot } from '../providers/claude/paths';

const PROJECT = '/workspace/demo-app';
const PARENT = '01990000-0000-7000-8000-000000000001';
const CHILD = '01990000-0000-7000-8000-000000000002';

describe('conversation fork source', () => {
    let home: string;

    beforeEach(async () => {
        home = await mkdtemp(join(tmpdir(), 'caxri-fork-source-'));
    });

    afterEach(async () => {
        await rm(home, { force: true, recursive: true });
    });

    async function write(path: string, records: unknown[]): Promise<string> {
        await mkdir(join(path, '..'), { recursive: true });
        await writeFile(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
        return path;
    }

    it('reads a Codex fork from session_meta forked_from_id', async () => {
        const path = await write(join(home, `rollout-2026-10-20T09-00-00-${CHILD}.jsonl`), [
            {
                type: 'session_meta',
                payload: {
                    id: CHILD,
                    forked_from_id: PARENT,
                    cwd: PROJECT,
                    source: 'cli',
                },
            },
            {
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'input_text', text: 'Refactor the cache layer' }],
                },
            },
        ]);

        await expect(
            classifyConversationCandidate(
                { provider: 'codex', providerSessionId: CHILD, path, updatedAt: 1 },
                new Map(),
            ),
        ).resolves.toMatchObject({ forkedFromId: PARENT });
    });

    it('reads a Grok fork from summary.json parent_session_id', async () => {
        const root = join(home, 'grok', CHILD);
        await mkdir(root, { recursive: true });
        await writeFile(
            join(root, 'summary.json'),
            JSON.stringify({
                info: { id: CHILD, cwd: PROJECT },
                session_kind: null,
                parent_session_id: PARENT,
            }),
        );
        const path = await write(join(root, 'updates.jsonl'), [
            {
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                    sessionId: CHILD,
                    update: {
                        sessionUpdate: 'user_message_chunk',
                        content: { type: 'text', text: 'Plan the migration' },
                    },
                },
            },
        ]);

        await expect(
            classifyConversationCandidate(
                { provider: 'grok', providerSessionId: CHILD, path, updatedAt: 1 },
                new Map(),
            ),
        ).resolves.toMatchObject({ forkedFromId: PARENT });
    });

    it('reads a Claude fork from forkedFrom and ignores a record naming itself', async () => {
        const record = (forkedFrom: unknown) => ({
            type: 'user',
            cwd: PROJECT,
            entrypoint: 'cli',
            isSidechain: false,
            sessionId: CHILD,
            forkedFrom,
            message: { role: 'user', content: 'Fix the login form' },
        });
        const candidate = (path: string) => ({
            provider: 'claude' as const,
            providerSessionId: CHILD,
            path,
            updatedAt: 1,
        });
        const directory = claudeTranscriptRoot(join(home, '.claude'), PROJECT);
        const forked = await write(join(directory, `${CHILD}.jsonl`), [
            record({ sessionId: PARENT, messageUuid: 'm1' }),
        ]);
        await expect(
            classifyConversationCandidate(candidate(forked), new Map()),
        ).resolves.toMatchObject({
            forkedFromId: PARENT,
        });

        const plain = await write(join(directory, `${CHILD}.jsonl`), [
            record({ sessionId: CHILD }),
        ]);
        const parsed = await classifyConversationCandidate(candidate(plain), new Map());
        expect(parsed).not.toHaveProperty('forkedFromId');
    });
});
