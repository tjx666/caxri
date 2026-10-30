import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentEnvironment } from '../contract';
import { claudeTranscriptRoot } from '../providers/claude/paths';
import { SessionSearchEngine } from '../session-search/engine';
import { parseSessionOperators } from '../session-search/query';
import { SessionSearchStore } from '../session-search/store';

const NOW = Date.parse('2026-10-13T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const PROJECT = '/workspace/demo-app';
const BILLING = '6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7';
const ONBOARDING = '7a2d3b4c-5e6f-4a70-8b81-a3c4d5e6f708';
const SUBAGENT = '8b3e4c5d-6f70-4b81-9c92-b4d5e6f70819';

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

describe('Session search relaxation, filters, and hosted conversations', () => {
    let home: string;
    let environment: AgentEnvironment;
    let store: SessionSearchStore;
    let engine: SessionSearchEngine;

    beforeEach(async () => {
        home = await mkdtemp(join(tmpdir(), 'caxri-session-search-'));
        environment = { homeDirectory: home, variables: {} };
        store = await SessionSearchStore.open(join(home, 'session-search.db'));
        engine = new SessionSearchEngine(store, environment, { now: () => NOW });
    });

    afterEach(async () => {
        store.close();
        await rm(home, { force: true, recursive: true });
    });

    function transcriptPath(sessionId: string): string {
        return join(claudeTranscriptRoot(join(home, '.claude'), PROJECT), `${sessionId}.jsonl`);
    }

    async function writeTranscript(sessionId: string, records: unknown[], updatedAt: number) {
        const path = transcriptPath(sessionId);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
        await utimes(path, updatedAt / 1000, updatedAt / 1000);
    }

    async function seed() {
        await writeTranscript(
            BILLING,
            [
                user(BILLING, 'Why does the invoice total drift by a cent?'),
                assistant(BILLING, 'Rounding happens per line item before the tax is applied.'),
            ],
            NOW - DAY,
        );
        await writeTranscript(
            ONBOARDING,
            [
                user(ONBOARDING, 'Add a welcome tour to onboarding'),
                assistant(ONBOARDING, 'The tour explains the invoice page last.'),
            ],
            NOW - 40 * DAY,
        );
        // A scripted run is not a conversation the user had; it must never surface.
        await writeTranscript(
            SUBAGENT,
            [user(SUBAGENT, 'invoice audit', { entrypoint: 'sdk-cli' })],
            NOW,
        );
        await engine.indexer.refresh();
    }

    describe('relaxation', () => {
        it('reports the phrase level when a message holds the query as one phrase', async () => {
            await seed();

            const response = engine.search({ query: 'invoice total', limit: 10 });

            expect(response.relaxation).toBe('phrase');
            expect(response.hits.map((hit) => hit.agentSessionId)).toEqual([BILLING]);
        });

        it('falls back to all words when no message holds the phrase', async () => {
            await seed();

            // Both words are in the billing conversation, but never next to each other in that order.
            const response = engine.search({ query: 'cent invoice', limit: 10 });

            expect(response.relaxation).toBe('allWords');
            expect(response.hits.map((hit) => hit.agentSessionId)).toEqual([BILLING]);
        });

        it('falls back to any word when no conversation holds every word', async () => {
            await seed();

            const response = engine.search({ query: 'invoice zebra', limit: 10 });

            expect(response.relaxation).toBe('anyWord');
            expect(
                response.hits
                    .map((hit) => hit.agentSessionId)
                    .toSorted((left, right) => left.localeCompare(right)),
            ).toEqual([BILLING, ONBOARDING].toSorted((left, right) => left.localeCompare(right)));
            // The snippet quotes the word that did match.
            expect(response.hits[0].snippet?.highlights.length).toBeGreaterThan(0);
        });

        it('reports no relaxation when even one word matches nothing', async () => {
            await seed();

            const response = engine.search({ query: 'zebra giraffe', limit: 10 });

            expect(response.hits).toEqual([]);
            expect(response.relaxation).toBe('phrase');
        });
    });

    describe('filters and the current Project', () => {
        it('keeps conversations updated inside the before and after window', async () => {
            await seed();
            const search = (window: { afterMs?: number; beforeMs?: number }) =>
                engine
                    .search({ query: '', limit: 10, ...window })
                    .hits.map((hit) => hit.agentSessionId);

            expect(search({ afterMs: NOW - 2 * DAY })).toEqual([BILLING]);
            expect(search({ beforeMs: NOW - 10 * DAY })).toEqual([ONBOARDING]);
            expect(search({ afterMs: NOW - 50 * DAY, beforeMs: NOW - 10 * DAY })).toEqual([
                ONBOARDING,
            ]);
        });

        it('keeps conversations whose folder contains a project string', async () => {
            await seed();

            expect(
                engine.search({ query: 'invoice', limit: 10, projects: ['demo-app'] }).hits,
            ).toHaveLength(2);
            expect(
                engine.search({ query: 'invoice', limit: 10, projects: ['other'] }).hits,
            ).toEqual([]);
        });

        it('ranks the preferred root first without dropping the rest', async () => {
            await seed();
            const OTHER = '5d6e7f80-9192-4a03-b4c5-d6e7f8091a2b';
            const otherCwd = '/workspace/other-app';
            const path = join(
                claudeTranscriptRoot(join(home, '.claude'), otherCwd),
                `${OTHER}.jsonl`,
            );
            await mkdir(dirname(path), { recursive: true });
            await writeFile(
                path,
                `${JSON.stringify({ ...user(OTHER, 'Unrelated chore'), cwd: otherCwd })}\n${JSON.stringify({ ...assistant(OTHER, 'The invoice is fine.'), cwd: otherCwd })}\n`,
            );
            await utimes(path, NOW / 1000, NOW / 1000);
            await engine.indexer.refresh();

            const withoutHint = engine.search({ query: 'invoice', limit: 10 });
            const withHint = engine.search({
                query: 'invoice',
                limit: 10,
                preferredRoot: otherCwd,
            });

            expect(withoutHint.hits[0].agentSessionId).toBe(BILLING);
            expect(withHint.hits.map((hit) => hit.agentSessionId)[0]).toBe(OTHER);
            expect(withHint.hits).toHaveLength(3);
        });
    });

    describe('hosted conversations', () => {
        const HOSTED = '9c4f5d6e-7081-4c92-8da3-c5e6f708192a';
        const hostedRecords = () => [
            user(HOSTED, 'Draft a note to the vendor', { entrypoint: 'sdk-ts' }),
            assistant(HOSTED, 'Even a probe with only 21 tokens waits 30 to 190 seconds.'),
        ];

        const indexedMessages = (agentSessionId: string) =>
            engine.preview({ provider: 'claude', agentSessionId, query: '' }).messages.length;

        it('reads a hosted body only after a Session holds it', async () => {
            await seed();
            await writeTranscript(HOSTED, hostedRecords(), NOW);
            const key = `claude:${HOSTED}`;

            await engine.indexer.refresh();
            // Held, but the pass skipped the body: nothing to find until the next pass reads it.
            expect(
                engine.search({ query: 'probe with only', limit: 10, heldKeys: [key] }).hits,
            ).toEqual([]);
            expect(indexedMessages(HOSTED)).toBe(0);

            await engine.indexer.refresh(new Set([key]));
            expect(
                engine
                    .search({ query: 'probe with only', limit: 10, heldKeys: [key] })
                    .hits.map((hit) => hit.agentSessionId),
            ).toEqual([HOSTED]);
            expect(indexedMessages(HOSTED)).toBe(2);
        });

        it('leaves hosted conversations out of the pending count', async () => {
            await seed();
            await writeTranscript(HOSTED, hostedRecords(), NOW);
            await engine.indexer.refresh();
            // The file changes again; nothing holds it, so no one is waiting for it.
            await writeTranscript(HOSTED, hostedRecords(), NOW + 1000);
            await writeTranscript(
                BILLING,
                [user(BILLING, 'Why does the invoice total drift by a cent?')],
                NOW + 2000,
            );

            let pending = 0;
            let isDone = false;
            const runPass = async () => {
                try {
                    await engine.indexer.refresh();
                } finally {
                    isDone = true;
                }
            };
            const pass = runPass();
            while (!isDone) {
                pending = Math.max(pending, engine.indexer.progress().pending);
                // eslint-disable-next-line no-await-in-loop -- sampling the count while the pass runs
                await new Promise((resolve) => setImmediate(resolve));
            }
            await pass;

            expect(pending).toBe(1);
        });
    });
});

describe('Session search operators', () => {
    it('extracts agent, project, and date operators and leaves the words', () => {
        const parsed = parseSessionOperators(
            'invoice agent:Codex project:billing before:2026-10-01 after:2026-09-01 rounding',
        );

        expect(parsed.text).toBe('invoice rounding');
        expect(parsed.filters).toEqual({
            agents: ['codex'],
            projects: ['billing'],
            before: '2026-10-01',
            after: '2026-09-01',
        });
        expect(parsed.beforeMs).toBe(new Date(2026, 9, 1).getTime());
        expect(parsed.afterMs).toBe(new Date(2026, 8, 1).getTime());
    });

    it('accepts quoted project values and repeated agents', () => {
        const parsed = parseSessionOperators(
            'project:"my app" agent:claude agent:grok agent:claude',
        );

        expect(parsed.text).toBe('');
        expect(parsed.filters.projects).toEqual(['my app']);
        expect(parsed.filters.agents).toEqual(['claude', 'grok']);
    });

    it('keeps an operator with an unusable value as plain words', () => {
        const parsed = parseSessionOperators(
            'agent:gemini before:2026-02-31 after:yesterday project: see http://x error:42',
        );

        expect(parsed.text).toBe(
            'agent:gemini before:2026-02-31 after:yesterday project: see http://x error:42',
        );
        expect(parsed.filters).toEqual({ agents: [], projects: [] });
        expect(parsed.beforeMs).toBeUndefined();
    });

    it('does not start an operator in the middle of a word', () => {
        expect(parseSessionOperators('subagent:claude').text).toBe('subagent:claude');
    });
});
