import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentEnvironment } from '../contract';
import { writeAntigravityConversation } from '../providers/antigravity/__tests__/fixtures/conversation-database';
import { SessionSearchEngine } from '../session-search/engine';
import { SessionSearchStore } from '../session-search/store';

const NOW = Date.parse('2026-10-13T12:00:00Z');
const PROJECT = '/workspace/demo-app';
const BILLING = '6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7';
const SUBAGENT = '8b3e4c5d-6f70-4b81-9c92-b4d5e6f70819';
const AT = Math.floor(NOW / 1000) - 3600;

describe('Session search over Antigravity conversations', () => {
    let home: string;
    let environment: AgentEnvironment;
    let store: SessionSearchStore;
    let engine: SessionSearchEngine;

    beforeEach(async () => {
        home = await mkdtemp(join(tmpdir(), 'caxri-session-search-agy-'));
        environment = { homeDirectory: home, variables: {} };
        store = await SessionSearchStore.open(join(home, 'session-search.db'));
        engine = new SessionSearchEngine(store, environment, { now: () => NOW });
    });

    afterEach(async () => {
        store.close();
        await rm(home, { force: true, recursive: true });
    });

    it('finds a conversation by its generated title and its messages, never its thinking', async () => {
        await writeAntigravityConversation(home, {
            id: BILLING,
            cwd: PROJECT,
            title: 'Invoice rounding drift',
            turns: [
                {
                    prompt: 'Why does the total drift by a cent?',
                    reply: 'Rounding happens per line item before tax.',
                    at: AT,
                },
            ],
        });
        await writeAntigravityConversation(home, {
            id: SUBAGENT,
            cwd: PROJECT,
            source: 16,
            turns: [{ prompt: 'Audit the line item rounding', at: AT }],
        });
        await engine.indexer.refresh();

        const byTitle = engine.search({ query: 'invoice', limit: 10 });
        expect(byTitle.hits).toMatchObject([
            {
                provider: 'antigravity',
                agentSessionId: BILLING,
                cwd: PROJECT,
                field: 'title',
                title: 'Invoice rounding drift',
            },
        ]);
        // The subagent's conversation mentions "line item" too, but is not one the user had.
        expect(
            engine.search({ query: 'line item', limit: 10 }).hits.map((hit) => hit.agentSessionId),
        ).toEqual([BILLING]);
        expect(engine.search({ query: 'synthetic thinking', limit: 10 }).hits).toEqual([]);
        await expect(engine.indexer.inspect('antigravity', BILLING)).resolves.toMatchObject({
            cwd: PROJECT,
            title: 'Invoice rounding drift',
        });
    });

    it('re-reads a conversation after Antigravity writes another turn', async () => {
        const conversation = {
            id: BILLING,
            cwd: PROJECT,
            turns: [{ prompt: 'Add a welcome tour', reply: 'Added the tour.', at: AT }],
        };
        const path = await writeAntigravityConversation(home, conversation);
        await engine.indexer.refresh();
        expect(engine.search({ query: 'onboarding checklist', limit: 10 }).hits).toEqual([]);

        // Replace the whole database: the indexer's read-only opens leave `-wal` and `-shm` beside it.
        await Promise.all(
            ['', '-wal', '-shm'].map((suffix) => rm(`${path}${suffix}`, { force: true })),
        );
        await writeAntigravityConversation(home, {
            ...conversation,
            turns: [
                ...conversation.turns,
                { prompt: 'Now add an onboarding checklist', at: AT + 60 },
            ],
        });
        await engine.indexer.refresh();

        expect(
            engine
                .search({ query: 'onboarding checklist', limit: 10 })
                .hits.map((hit) => hit.agentSessionId),
        ).toEqual([BILLING]);
        expect(engine.search({ query: 'welcome tour', limit: 10 }).hits).toHaveLength(1);
    });
});
