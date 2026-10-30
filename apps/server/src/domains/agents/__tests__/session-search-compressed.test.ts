import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentEnvironment } from '../contract';
import { scanFailedFields } from '../session-search/client';
import { SessionSearchEngine } from '../session-search/engine';
import { SessionSearchStore } from '../session-search/store';
import { discoverTranscripts } from '../transcript-discovery';
import type { TranscriptScanCursor } from '../transcript-scan';
import { scanTranscriptLines } from '../transcript-scan';

const NOW = Date.parse('2026-10-13T12:00:00Z');
const PROJECT = '/workspace/demo-app';
const PLAIN = '01990000-0000-7000-8000-000000000001';
const COMPRESSED = '01990000-0000-7000-8000-000000000002';
const BOTH = '01990000-0000-7000-8000-000000000003';
const BROKEN = '01990000-0000-7000-8000-000000000004';
const TRUNCATED = '01990000-0000-7000-8000-000000000005';
const ROLLOUT = '01990000-0000-7000-8000-0000000000aa';

const meta = (id: string) => ({
    type: 'session_meta',
    payload: { id, cwd: PROJECT, source: 'cli', originator: 'codex_cli_rs' },
});
const message = (role: 'assistant' | 'user', text: string) => ({
    type: 'response_item',
    payload: {
        type: 'message',
        role,
        content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
    },
});
const jsonl = (records: unknown[]) =>
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
const conversation = (id: string, prompt: string, reply: string) =>
    jsonl([meta(id), message('user', prompt), message('assistant', reply)]);

describe('compressed Codex rollouts in Session search', () => {
    let home: string;
    let day: string;
    let environment: AgentEnvironment;
    let store: SessionSearchStore;
    let engine: SessionSearchEngine;

    beforeEach(async () => {
        const temporary = await mkdtemp(join(tmpdir(), 'caxri-session-search-zst-'));
        home = await realpath(temporary);
        day = join(home, '.codex/sessions/2026/10/12');
        await mkdir(day, { recursive: true });
        environment = { homeDirectory: home, variables: {} };
        store = await SessionSearchStore.open(join(home, 'session-search.db'));
        engine = new SessionSearchEngine(store, environment, { now: () => NOW });
    });

    afterEach(async () => {
        store.close();
        await rm(home, { force: true, recursive: true });
    });

    async function rollout(name: string, content: Buffer | string, updatedAt = NOW - 120_000) {
        const path = join(day, name);
        await writeFile(path, content);
        await utimes(path, updatedAt / 1000, updatedAt / 1000);
        return path;
    }
    const plainName = (id: string, suffix = '') =>
        `rollout-2026-10-12T09-00-00-${id}${suffix}.jsonl`;
    const zst = (text: string) => zstdCompressSync(Buffer.from(text));

    it('discovers a .jsonl.zst rollout only when asked, preferring a plain sibling', async () => {
        await rollout(plainName(PLAIN), '');
        await rollout(`${plainName(COMPRESSED)}.zst`, zst(''));
        await rollout(`${plainName(COMPRESSED, `_${ROLLOUT}`)}.zst`, zst(''));
        await rollout(plainName(BOTH), '');
        await rollout(`${plainName(BOTH)}.zst`, zst(''));

        const summarize = (found: Awaited<ReturnType<typeof discoverTranscripts>>) =>
            found
                .map(({ transcriptId, agentSessionId, isContinuation, main }) => ({
                    transcriptId,
                    agentSessionId,
                    isContinuation,
                    isCompressed: main.path.endsWith('.zst'),
                }))
                .toSorted((a, b) => a.transcriptId.localeCompare(b.transcriptId));

        expect(summarize(await discoverTranscripts(environment))).toEqual([
            {
                transcriptId: PLAIN,
                agentSessionId: PLAIN,
                isContinuation: false,
                isCompressed: false,
            },
            {
                transcriptId: BOTH,
                agentSessionId: BOTH,
                isContinuation: false,
                isCompressed: false,
            },
        ]);
        expect(
            summarize(await discoverTranscripts(environment, { includeCompressed: true })),
        ).toEqual([
            {
                transcriptId: PLAIN,
                agentSessionId: PLAIN,
                isContinuation: false,
                isCompressed: false,
            },
            {
                transcriptId: COMPRESSED,
                agentSessionId: COMPRESSED,
                isContinuation: false,
                isCompressed: true,
            },
            {
                transcriptId: BOTH,
                agentSessionId: BOTH,
                isContinuation: false,
                isCompressed: false,
            },
            {
                transcriptId: ROLLOUT,
                agentSessionId: COMPRESSED,
                isContinuation: true,
                isCompressed: true,
            },
        ]);
    });

    it('finds, previews, and inspects a compressed conversation like its plain equivalent', async () => {
        await rollout(
            plainName(PLAIN),
            conversation(PLAIN, 'Plan the harbor lantern rollout', 'Lanterns ship on Tuesday.'),
        );
        await rollout(
            `${plainName(COMPRESSED)}.zst`,
            zst(
                conversation(
                    COMPRESSED,
                    'Plan the meadow lantern rollout',
                    'Lanterns ship on Friday.',
                ),
            ),
        );
        // Both forms of one rollout: the plain file is current, so its messages are indexed once.
        await rollout(
            plainName(BOTH),
            conversation(BOTH, 'Sketch the orchard lantern map', 'The map is ready.'),
        );
        await rollout(
            `${plainName(BOTH)}.zst`,
            zst(conversation(BOTH, 'Sketch the orchard lantern map', 'The map is ready.')),
        );

        const report = await engine.indexer.refresh();
        expect(report).toMatchObject({ compressed: 1, failed: 0, scanFailed: {}, excluded: {} });

        const ids = (query: string) =>
            engine
                .search({ query, limit: 10 })
                .hits.map((hit) => hit.agentSessionId)
                .toSorted((left, right) => left.localeCompare(right));
        expect(ids('lantern rollout')).toEqual([PLAIN, COMPRESSED]);
        expect(ids('friday')).toEqual([COMPRESSED]);
        expect(ids(COMPRESSED)).toEqual([COMPRESSED]);
        expect(ids(COMPRESSED.slice(0, 8))).toContain(COMPRESSED);
        const [compressed] = engine.search({ query: 'meadow', limit: 10 }).hits;
        expect(compressed).toMatchObject({ field: 'title', cwd: PROJECT });
        expect(engine.search({ query: 'orchard map', limit: 10 }).hits).toHaveLength(1);
        expect(
            engine.preview({ provider: 'codex', agentSessionId: BOTH, query: 'ready' }).matchCount,
        ).toBe(1);

        const preview = engine.preview({
            provider: 'codex',
            agentSessionId: COMPRESSED,
            query: 'friday',
        });
        expect(preview.messages.map((entry) => entry.text)).toEqual([
            'Plan the meadow lantern rollout',
            'Lanterns ship on Friday.',
        ]);
        expect(await engine.indexer.inspect('codex', COMPRESSED)).toEqual({
            cwd: PROJECT,
            title: 'Plan the meadow lantern rollout',
            updatedAt: NOW - 120_000,
        });

        // An unchanged compressed file is not read again.
        expect(await engine.indexer.refresh()).toMatchObject({ changed: 0 });
    });

    it('isolates a corrupt or truncated compressed rollout and reports it by cause', async () => {
        await rollout(
            plainName(PLAIN),
            conversation(PLAIN, 'Plan the harbor lantern rollout', 'Lanterns ship on Tuesday.'),
        );
        await rollout(`${plainName(BROKEN)}.zst`, Buffer.from('not a zstd stream'));
        // Random text keeps the stream long, so the cut lands well past the head the metadata read needs.
        const filler = Array.from({ length: 64 }, () =>
            message('assistant', randomBytes(24 * 1024).toString('hex')),
        );
        const full = zst(
            jsonl([meta(TRUNCATED), message('user', 'Survey the canyon bridge'), ...filler]),
        );
        await rollout(`${plainName(TRUNCATED)}.zst`, full.subarray(0, full.length / 2));

        const report = await engine.indexer.refresh();

        expect(report).toMatchObject({
            compressed: 2,
            failed: 0,
            excluded: { unreadable: 1 },
            scanFailed: { decompressFailed: 1 },
        });
        expect(scanFailedFields(report.scanFailed)).toEqual({ scanFailedDecompressFailed: 1 });
        expect(engine.search({ query: 'harbor', limit: 10 }).hits).toHaveLength(1);
        // The lines before the fault are indexed.
        expect(engine.search({ query: 'canyon bridge', limit: 10 }).hits[0]).toMatchObject({
            agentSessionId: TRUNCATED,
        });
    });
});

describe('scanTranscriptLines on a compressed transcript', () => {
    it('reads every line once, including a final line without a newline', async () => {
        const temporary = await mkdtemp(join(tmpdir(), 'caxri-transcript-zst-'));
        const base = await realpath(temporary);
        try {
            const root = join(base, 'day');
            await mkdir(root);
            const path = join(root, 'rollout.jsonl.zst');
            await writeFile(path, zstdCompressSync(Buffer.from('{"a":1}\n{"b":2}\n{"c":3}')));
            const location = { baseRoot: base, root, path };
            const cursor: TranscriptScanCursor = { offset: 0 };
            const lines: string[] = [];

            const size = await scanTranscriptLines(location, cursor, (line) => lines.push(line), {
                completeLinesOnly: true,
            });

            expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
            expect(cursor.offset).toBe(size);
            await scanTranscriptLines(location, cursor, (line) => lines.push(line));
            expect(lines).toHaveLength(3);
        } finally {
            await rm(base, { force: true, recursive: true });
        }
    });
});
