import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentEnvironment } from '../contract';
import { claudeTranscriptRoot } from '../providers/claude/paths';
import { excludedFields } from '../session-search/client';
import { SessionSearchEngine } from '../session-search/engine';
import { metadataMatch, parseSessionQuery } from '../session-search/query';
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

describe('Session search index', () => {
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

    it('ranks a title match first and finds the rest by message content with a highlighted snippet', async () => {
        await seed();

        const { hits, usedSubstringScan } = engine.search({ query: 'invoice', limit: 10 });

        expect(usedSubstringScan).toBe(false);
        expect(hits.map((hit) => hit.agentSessionId)).toEqual([BILLING, ONBOARDING]);
        const [billing, onboarding] = hits;
        // Claude's title is the first real prompt, which mentions the invoice.
        expect(billing.field).toBe('title');
        expect(onboarding.field).toBe('content');
        expect(onboarding.cwd).toBe(PROJECT);
        const snippet = onboarding.snippet!;
        const [start, end] = snippet.highlights[0];
        expect(snippet.text.slice(start, end).toLowerCase()).toBe('invoice');
    });

    it('ranks an ID match above content matches and scans short terms as substrings', async () => {
        await seed();

        expect(engine.search({ query: ONBOARDING.slice(0, 8), limit: 10 }).hits[0]).toMatchObject({
            agentSessionId: ONBOARDING,
            field: 'id',
        });
        const short = engine.search({ query: 'ta', limit: 10 });
        expect(short.usedSubstringScan).toBe(true);
        expect(short.hits.map((hit) => hit.agentSessionId)).toContain(BILLING);
    });

    it('lists recent conversations for an empty query and honors restrict keys', async () => {
        await seed();

        expect(
            engine.search({ query: '', limit: 10 }).hits.map((hit) => hit.agentSessionId),
        ).toEqual([BILLING, ONBOARDING]);
        expect(
            engine
                .search({
                    query: 'invoice',
                    restrict: { mode: 'exclude', keys: [`claude:${BILLING}`] },
                    limit: 10,
                })
                .hits.map((hit) => hit.agentSessionId),
        ).toEqual([ONBOARDING]);
    });

    it('indexes only appended lines on the next pass and drops a deleted transcript', async () => {
        await seed();
        const path = transcriptPath(BILLING);
        await appendFile(path, `${JSON.stringify(user(BILLING, 'Now check the refund ledger'))}\n`);
        await utimes(path, NOW / 1000, NOW / 1000);

        const report = await engine.indexer.refresh();

        expect(report.changed).toBe(1);
        expect(engine.search({ query: 'refund ledger', limit: 10 }).hits).toHaveLength(1);
        expect(engine.search({ query: 'rounding', limit: 10 }).hits).toHaveLength(1);

        await rm(transcriptPath(ONBOARDING));
        expect((await engine.indexer.refresh()).removed).toBe(1);
        expect(engine.search({ query: 'welcome tour', limit: 10 }).hits).toEqual([]);
    });

    it('finds an SDK-started conversation by content only while a Caxri Session holds it', async () => {
        await seed();
        const HOSTED = '9c4f5d6e-7081-4c92-8da3-c5e6f708192a';
        // Agent Chat starts through the SDK; Caxri's `/rename` later appends a `claude -p` record to the same file.
        await writeTranscript(
            HOSTED,
            [
                user(HOSTED, 'Draft a note to the vendor', { entrypoint: 'sdk-ts' }),
                assistant(HOSTED, 'Even a probe with only 21 tokens waits 30 to 190 seconds.'),
                user(HOSTED, '/rename vendor note', { entrypoint: 'sdk-cli' }),
            ],
            NOW,
        );
        await engine.indexer.refresh();
        const search = (heldKeys?: string[]) =>
            engine
                .search({ query: 'probe with only', limit: 10, ...(heldKeys && { heldKeys }) })
                .hits.map((hit) => hit.agentSessionId);

        expect(search()).toEqual([]);
        expect(search([`claude:${HOSTED}`])).toEqual([HOSTED]);
        // Every term must still come from one message, wherever it is held.
        expect(
            engine.search({ query: 'probe vendor', limit: 10, heldKeys: [`claude:${HOSTED}`] })
                .hits,
        ).toEqual([]);
        expect(engine.search({ query: '', limit: 10 }).hits).toHaveLength(2);
    });

    it('indexes a conversation whose first prompt carries a screenshot larger than the head budget', async () => {
        // A pasted screenshot is inlined as base64 in the first prompt's record, which alone outweighs the head read.
        const screenshot = 'iVBORw0KGgo'.padEnd(400 * 1024, 'A');
        await writeTranscript(
            BILLING,
            [
                user(BILLING, '', {
                    message: {
                        role: 'user',
                        content: [
                            {
                                type: 'image',
                                source: {
                                    type: 'base64',
                                    media_type: 'image/png',
                                    data: screenshot,
                                },
                            },
                            { type: 'text', text: 'Why does the chart legend overlap the axis?' },
                        ],
                    },
                }),
                assistant(BILLING, 'The legend is anchored before the axis labels are measured.'),
            ],
            NOW - DAY,
        );
        await engine.indexer.refresh();

        const [hit] = engine.search({ query: 'axis labels are measured', limit: 10 }).hits;
        expect(hit).toMatchObject({ agentSessionId: BILLING, field: 'content' });
        expect(hit.title).toContain('chart legend');
    });

    it('counts each transcript the pass excludes by its cause', async () => {
        await seed();
        const sidechain = '9c4f5d6e-7081-4c92-8da3-c5e6f708192a';
        const folderless = 'ad506e7f-8192-4da3-9eb4-d6f708192a3b';
        const oversized = 'be617f80-92a3-4eb4-8fc5-e708192a3b4c';
        const readImage = 'cf7280a1-a3b4-4fc5-90d6-f8192a3b4c5d';
        await writeTranscript(
            sidechain,
            [user(sidechain, 'Audit the ledger', { isSidechain: true })],
            NOW,
        );
        await writeTranscript(folderless, [user(folderless, 'Hello', { cwd: undefined })], NOW);
        // Plain text is not inline media, so this first prompt stays past the head read's caps.
        await writeTranscript(oversized, [user(oversized, 'x'.repeat(600 * 1024))], NOW);
        // An image read with the Read tool is stored twice in the tool result; both copies collapse, so the folder
        // only that record carries is still found.
        const image = 'iVBORw0KGgo'.padEnd(300 * 1024, 'A');
        await writeTranscript(
            readImage,
            [
                user(readImage, 'Crop the chart to its legend', { cwd: undefined }),
                user(readImage, '', {
                    message: {
                        role: 'user',
                        content: [
                            {
                                type: 'tool_result',
                                content: [
                                    {
                                        type: 'image',
                                        source: {
                                            type: 'base64',
                                            media_type: 'image/png',
                                            data: image,
                                        },
                                    },
                                ],
                            },
                        ],
                    },
                    toolUseResult: { type: 'image', file: { base64: image, type: 'image/png' } },
                }),
            ],
            NOW,
        );

        const { excluded } = await engine.indexer.refresh();

        expect(excluded).toEqual({ missingFolder: 1, oversizedRecord: 1, sidechain: 1 });
        expect(engine.search({ query: 'crop the chart', limit: 10 }).hits[0]).toMatchObject({
            agentSessionId: readImage,
        });
        expect(excludedFields({ scripted: 1, oversizedRecord: 2 })).toMatchObject({
            excludedScripted: 1,
            excludedOversizedRecord: 2,
            excludedMissingFolder: 0,
        });
    });

    it('ranks a conversation holding the query as one phrase first and quotes that message', async () => {
        // The other conversation holds every term apart and repeats the long one, which bm25 alone would prefer.
        await writeTranscript(
            ONBOARDING,
            [
                user(ONBOARDING, 'Count token usage: token totals, token rates, token caps.'),
                assistant(ONBOARDING, '每个 token 都计费，token 表格有 42 行。'),
            ],
            NOW,
        );
        await writeTranscript(
            BILLING,
            [
                user(BILLING, 'How long does the batch run take?'),
                assistant(BILLING, '这次只用了 42 个 token 就完成了，但排队等了很久。'),
                user(BILLING, 'Then shorten the token budget.'),
            ],
            NOW - 20 * DAY,
        );
        await engine.indexer.refresh();

        for (const query of ['42个token', '42 个 token']) {
            const { hits } = engine.search({ query, limit: 10 });
            expect(hits.map((hit) => hit.agentSessionId)).toEqual([BILLING, ONBOARDING]);
            const snippet = hits[0].snippet!;
            expect(snippet.text).toContain('只用了 42 个 token 就完成了');
            expect(
                snippet.highlights.map(([start, end]) => snippet.text.slice(start, end)),
            ).toEqual(['42', '个', 'token']);
            // The FTS excerpt of the other conversation highlights the short terms too.
            const other = hits[1].snippet!;
            expect(other.highlights.map(([start, end]) => other.text.slice(start, end))).toEqual(
                expect.arrayContaining(['42', '个']),
            );
        }
    });

    it('matches text copied from a rendered message against its Markdown source', async () => {
        const ALERTS = 'ad5e6f70-8192-4da3-9eb4-d6f708192a3b';
        await writeTranscript(
            ALERTS,
            [
                user(ALERTS, 'Which alerts are noise?'),
                assistant(
                    ALERTS,
                    'The **embedding** alert (`text-embedding-small`) is a server issue.',
                ),
            ],
            NOW - DAY,
        );
        await engine.indexer.refresh();

        const [hit] = engine.search({
            query: 'embedding alert (text-embedding-small) is',
            limit: 10,
        }).hits;
        expect(hit).toMatchObject({ agentSessionId: ALERTS, field: 'content' });
        expect(hit.snippet?.text).not.toContain('`');
        expect(
            engine.search({ query: '`text-embedding-small`', limit: 10 }).hits[0]?.agentSessionId,
        ).toBe(ALERTS);
    });

    it('reads a conversation fresh for import', async () => {
        await seed();

        expect(await engine.indexer.inspect('claude', BILLING)).toEqual({
            cwd: PROJECT,
            title: 'Why does the invoice total drift by a cent?',
            updatedAt: NOW - DAY,
        });
        expect(await engine.indexer.inspect('claude', SUBAGENT)).toBeUndefined();
    });
});

describe('Session search query', () => {
    it('drops inline Markdown markers from a query', () => {
        expect(parseSessionQuery('`run()` **now**').terms).toEqual(['run()', 'now']);
    });

    it('lowercases and dedupes terms, and keeps short ones for a substring scan', () => {
        expect(parseSessionQuery('Invoice  invoice ab')).toEqual({
            terms: ['invoice', 'ab'],
            ftsQuery: '"invoice"',
            substrings: ['ab'],
            phrase: 'invoiceinvoiceab',
        });
    });

    it('splits a term where Chinese meets digits or Latin text', () => {
        expect(parseSessionQuery('只用42个token')).toEqual({
            terms: ['只用', '42', '个', 'token'],
            ftsQuery: '"token"',
            substrings: ['只用', '42', '个'],
            phrase: '只用42个token',
        });
        expect(parseSessionQuery('token').phrase).toBeUndefined();
    });

    it('needs every term in one field and an ID fragment of four characters', () => {
        const fields = { title: 'Fix invoice rounding', cwd: '/work/billing', ids: [BILLING] };
        expect(metadataMatch(['6f1c'], fields)).toBe('id');
        expect(metadataMatch(['6f1'], fields)).toBeUndefined();
        expect(metadataMatch(['invoice', 'rounding'], fields)).toBe('title');
        expect(metadataMatch(['billing'], fields)).toBe('path');
        expect(metadataMatch(['invoice', 'billing'], fields)).toBe('title');
    });

    it('matches a plain term against the folder a row shows, and a pasted path against the whole folder', () => {
        const fields = { cwd: '/Users/dev/code/app-worktrees/feat-x/server', ids: [BILLING] };
        expect(metadataMatch(['feat-x'], fields)).toBe('path');
        // A container segment the row hides would match every conversation under it.
        expect(metadataMatch(['worktrees'], fields)).toBeUndefined();
        expect(metadataMatch(['app-worktrees/feat-x'], fields)).toBe('path');
    });
});
