import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { claudeTranscriptRoot } from '../providers/claude/paths';
import { SessionSearchEngine } from '../session-search/engine';
import { SessionSearchStore } from '../session-search/store';

const NOW = Date.parse('2026-10-13T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const PROJECT = '/workspace/demo-app';
const BILLING = '6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7';
const ONBOARDING = '7a2d3b4c-5e6f-4a70-8b81-a3c4d5e6f708';

const user = (sessionId: string, text: string, extra: Record<string, unknown> = {}) => ({
    type: 'user',
    cwd: PROJECT,
    entrypoint: 'cli',
    isSidechain: false,
    sessionId,
    message: { role: 'user', content: text },
    ...extra,
});
const assistant = (sessionId: string, text: string) => ({
    type: 'assistant',
    cwd: PROJECT,
    isSidechain: false,
    sessionId,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
});

describe('Session search fork groups', () => {
    let home: string;
    let store: SessionSearchStore;
    let engine: SessionSearchEngine;

    beforeEach(async () => {
        home = await mkdtemp(join(tmpdir(), 'caxri-session-search-forks-'));
        store = await SessionSearchStore.open(join(home, 'session-search.db'));
        engine = new SessionSearchEngine(
            store,
            { homeDirectory: home, variables: {} },
            { now: () => NOW },
        );
    });

    afterEach(async () => {
        store.close();
        await rm(home, { force: true, recursive: true });
    });

    async function writeTranscript(sessionId: string, records: unknown[], updatedAt: number) {
        const path = join(
            claudeTranscriptRoot(join(home, '.claude'), PROJECT),
            `${sessionId}.jsonl`,
        );
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
        await utimes(path, updatedAt / 1000, updatedAt / 1000);
    }

    it('marks the original and its Claude forks as one fork group with each branch size', async () => {
        const FORK_A = 'a1111111-4d5e-4f60-8a71-92b3c4d5e6f7';
        const FORK_B = 'b2222222-4d5e-4f60-8a71-92b3c4d5e6f7';
        const shared = [
            user(BILLING, 'Why does the invoice total drift by a cent?'),
            assistant(BILLING, 'Rounding happens per line item before the tax is applied.'),
        ];
        await writeTranscript(BILLING, shared, NOW - 3 * DAY);
        // `claude --fork-session` copies the earlier records under a new ID, each stamped with its source.
        await Promise.all(
            (
                [
                    [FORK_A, 2 * DAY],
                    [FORK_B, DAY],
                ] as const
            ).map(([id, age]) =>
                writeTranscript(
                    id,
                    [
                        ...shared.map((record, index) => ({
                            ...record,
                            sessionId: id,
                            forkedFrom: { sessionId: BILLING, messageUuid: `m${index}` },
                        })),
                        user(id, `Follow up in fork ${id.slice(0, 1)}`),
                    ],
                    NOW - age,
                ),
            ),
        );
        await engine.indexer.refresh();

        const { hits } = engine.search({ query: 'invoice total drift', limit: 10 });

        expect(new Set(hits.map((hit) => hit.agentSessionId))).toEqual(
            new Set([BILLING, FORK_A, FORK_B]),
        );
        expect(new Set(hits.map((hit) => hit.forkGroup))).toEqual(new Set([`claude:${BILLING}`]));
        expect(
            Object.fromEntries(hits.map((hit) => [hit.agentSessionId, hit.totalMessages])),
        ).toEqual({ [BILLING]: 2, [FORK_A]: 3, [FORK_B]: 3 });
        // A conversation outside any fork carries no group.
        await writeTranscript(
            ONBOARDING,
            [user(ONBOARDING, 'Add a welcome tour to onboarding')],
            NOW,
        );
        await engine.indexer.refresh();
        expect(
            engine.search({ query: 'welcome tour', limit: 10 }).hits[0]?.forkGroup,
        ).toBeUndefined();
    });

    it('groups sibling forks whose original is no longer indexed', async () => {
        const FORK_A = 'a1111111-4d5e-4f60-8a71-92b3c4d5e6f7';
        const FORK_B = 'b2222222-4d5e-4f60-8a71-92b3c4d5e6f7';
        await Promise.all(
            [FORK_A, FORK_B].map((id) =>
                writeTranscript(
                    id,
                    [
                        user(id, 'Why does the invoice total drift?', {
                            forkedFrom: { sessionId: BILLING },
                        }),
                    ],
                    NOW,
                ),
            ),
        );
        await engine.indexer.refresh();

        const { hits } = engine.search({ query: 'invoice', limit: 10 });

        expect(hits.map((hit) => hit.forkGroup)).toEqual([
            `claude:${BILLING}`,
            `claude:${BILLING}`,
        ]);
    });
});
