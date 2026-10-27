import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { zstdCompressSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import type { JsonRecord, UsageRequest } from '../development-usage';
import {
    CodexLedger,
    DevelopmentUsage,
    isProjectCwd,
    record,
    renderDevelopmentUsage,
    requestCost,
    tokenUsage,
    updateDevelopmentUsageReadme,
} from '../development-usage';
import {
    collectDevelopmentUsage,
    excludedDescendants,
    expandHome,
    jsonlLines,
} from '../update-development-usage';

const AT = '2026-01-01T00:00:00.000Z';
const LATER = '2026-01-01T00:10:00.000Z';
const CUTOFF = '2026-01-02T00:00:00.000Z';
const RAW = {
    input_tokens: 100,
    cached_input_tokens: 40,
    output_tokens: 10,
    reasoning_output_tokens: 4,
};
const folders: string[] = [];

afterEach(async () => {
    const pending = [...folders];
    folders.length = 0;
    await Promise.all(pending.map((folder) => rm(folder, { recursive: true, force: true })));
});

function context(model = 'gpt-6.1-sol'): JsonRecord {
    return { type: 'turn_context', payload: { model }, timestamp: AT };
}

function mirror(id = 'response-1', at = AT): JsonRecord {
    return { type: 'token_usage_record', timestamp: at, payload: { response_id: id, usage: RAW } };
}

function event(total = 110, at = LATER, last: JsonRecord = RAW): JsonRecord {
    return {
        type: 'event_msg',
        timestamp: at,
        payload: {
            type: 'token_count',
            info: { last_token_usage: last, total_token_usage: { ...RAW, total_tokens: total } },
        },
    };
}

function codexTotal(rows: JsonRecord[]): ReturnType<DevelopmentUsage['summary']> {
    const ledger = new CodexLedger();
    rows.forEach((row) => ledger.consume(row));
    const usage = new DevelopmentUsage(CUTOFF);
    ledger.finish().forEach((unit) => usage.add(unit.request, unit.aliases));
    return usage.summary();
}

function claude(id = 'message-1', raw: JsonRecord = {}): JsonRecord {
    return {
        type: 'assistant',
        timestamp: AT,
        cwd: '/workspace/caxri',
        requestId: 'request-1',
        message: {
            id,
            model: 'claude-opus-5',
            content: 'SYNTHETIC_PRIVATE_CONTENT',
            usage: { input_tokens: 100, output_tokens: 10, ...raw },
        },
    };
}

function grok(raw: JsonRecord, prompt = 'prompt-1'): JsonRecord {
    return {
        timestamp: AT,
        params: { update: { sessionUpdate: 'turn_completed', prompt_id: prompt, usage: raw } },
    };
}

async function fixtureFile(
    home: string,
    path: string,
    rows: JsonRecord[],
    isCompressed = false,
): Promise<void> {
    const target = join(home, path);
    await mkdir(dirname(target), { recursive: true });
    const text = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
    await writeFile(target, isCompressed ? zstdCompressSync(Buffer.from(text)) : text);
}

describe('development usage accounting', () => {
    it('counts a response and its event once even after a long tool interval and cumulative offset', () => {
        const total = codexTotal([context(), mirror(), event(900_110)]).providers.codex;
        expect(total.tokens).toBe(110);
        expect(total.requests).toBe(1);
    });

    it('keeps billed compaction responses when the event has no incremental usage', () => {
        const total = codexTotal([context(), mirror(), event(110, LATER, {})]).providers.codex;
        expect(total.tokens).toBe(110);
    });

    it('ignores unchanged cumulative refreshes and resumes counting after a reset', () => {
        const total = codexTotal([
            context(),
            event(110, AT),
            event(110, LATER),
            event(55, '2026-01-01T00:20:00Z', { input_tokens: 50, output_tokens: 5 }),
            event(110, '2026-01-01T00:30:00Z', { input_tokens: 50, output_tokens: 5 }),
        ]).providers.codex;
        expect(total.requests).toBe(3);
        expect(total.tokens).toBe(220);
    });

    it('uses the real line boundary and never pairs across a subsequent mirror', () => {
        const ledger = new CodexLedger();
        ledger.consume(context(), 1);
        ledger.consume(mirror(), 2);
        ledger.consume(event(), 203);
        expect(ledger.finish()).toHaveLength(2);
        expect(
            codexTotal([context(), mirror(), mirror('response-2'), event()]).providers.codex
                .requests,
        ).toBe(2);
    });

    it('deduplicates forked response IDs across rollouts', () => {
        const usage = new DevelopmentUsage(CUTOFF);
        for (const at of [AT, LATER]) {
            const ledger = new CodexLedger();
            ledger.consume(context());
            ledger.consume(mirror('shared-response', at));
            ledger.finish().forEach((unit) => usage.add(unit.request, unit.aliases));
        }
        expect(usage.summary().providers.codex.tokens).toBe(110);
    });

    it('supports old event-only rollouts and retains the model at each request', () => {
        const total = codexTotal([
            context('gpt-6-astra'),
            event(110, AT),
            context(),
            event(220, LATER),
        ]).providers.codex;
        expect(total.tokens).toBe(220);
        expect(total.knownCostUsd).toBeCloseTo(0.001364, 6);
    });

    it('attributes requests to their turn cwd when a rollout enters or leaves the project', () => {
        for (const initial of [true, false]) {
            const ledger = new CodexLedger(initial);
            ledger.consume(context());
            ledger.consume(mirror('before'));
            ledger.consume({ type: 'turn_context', payload: { cwd: '/workspace/other' } });
            ledger.consume(event(110));
            ledger.consume(mirror('outside'));
            ledger.consume({ type: 'turn_context', payload: { cwd: '/workspace/caxri' } });
            ledger.consume(event(220));
            ledger.consume(mirror('inside'));
            ledger.consume(event(330));
            expect(ledger.finish().map((unit) => unit.responseId)).toEqual(
                initial ? ['before', 'inside'] : ['inside'],
            );
        }
    });

    it('merges Claude streamed blocks by message ID even if request IDs differ', () => {
        const usage = new DevelopmentUsage(CUTOFF);
        usage.claude(
            claude('message-1', {
                input_tokens: 10,
                output_tokens: 1,
                cache_read_input_tokens: 100,
            }),
        );
        usage.claude({
            ...claude('message-1', {
                input_tokens: 10,
                output_tokens: 3,
                cache_read_input_tokens: 150,
            }),
            requestId: 'request-2',
        });
        usage.claude(claude('child-message'));
        expect(usage.summary().providers.claude.tokens).toBe(273);
        expect(usage.summary().providers.claude.requests).toBe(2);
    });

    it('prices detailed cache writes when the legacy generic total is zero', () => {
        const raw = {
            input_tokens: 100,
            output_tokens: 10,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 0,
            cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 30 },
        };
        const usage = tokenUsage(raw, 'claude');
        expect(usage.input + usage.output).toBe(170);
        expect(
            requestCost({ provider: 'claude', model: 'claude-opus-5', at: AT, usage }),
        ).toBeCloseTo(0.0011225, 9);
    });

    it('prices 1-hour writes separately and unspecified writes at the 5-minute rate', () => {
        const usage = tokenUsage(
            {
                input_tokens: 100,
                output_tokens: 10,
                cache_read_input_tokens: 20,
                cache_creation_input_tokens: 100,
                cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 30 },
            },
            'claude',
        );
        expect(
            requestCost({ provider: 'claude', model: 'claude-opus-5', at: AT, usage }),
        ).toBeCloseTo(0.0014975, 9);
    });

    it('applies long-context prices to the entire request strictly above the threshold', () => {
        const make = (input: number): UsageRequest => ({
            provider: 'codex',
            model: 'gpt-6.1-sol',
            at: AT,
            usage: tokenUsage({ input_tokens: input }, 'codex'),
        });
        expect(requestCost(make(272_000))).toBe(0.544);
        expect(requestCost(make(272_001))).toBe(1.088004);
        const haiku = {
            provider: 'claude' as const,
            model: 'claude-haiku-5-5',
            at: AT,
            usage: tokenUsage({ input_tokens: 100_001 }, 'claude'),
        };
        expect(requestCost(haiku)).toBeCloseTo(0.0500005, 9);
    });

    it('adds Grok model rows once and uses native ticks without double-counting cache or reasoning', () => {
        const usage = new DevelopmentUsage(CUTOFF);
        const row = grok({
            inputTokens: 1000,
            outputTokens: 100,
            modelUsage: {
                'grok-example-a': {
                    inputTokens: 70,
                    outputTokens: 10,
                    cachedReadTokens: 40,
                    cacheCreationTokens: 20,
                    reasoningTokens: 5,
                    costUsdTicks: 7e9,
                },
                'grok-example-b': { inputTokens: 30, outputTokens: 10, costUsdTicks: 3e9 },
            },
        });
        usage.grok(row, 'unknown');
        usage.grok(row, 'unknown');
        expect(usage.summary().providers.grok).toMatchObject({
            tokens: 120,
            knownCostUsd: 1,
            requests: 2,
            cached: 40,
        });
    });

    it('distinguishes a recorded free request from unknown model cost', () => {
        const usage = new DevelopmentUsage(CUTOFF);
        usage.grok(grok({ inputTokens: 10, costUsdTicks: 0 }), 'grok-example');
        const unknown = {
            provider: 'codex' as const,
            model: 'unpriced-model',
            at: AT,
            usage: tokenUsage(RAW, 'codex'),
        };
        usage.add(unknown, ['unknown-response']);
        expect(usage.summary().providers.grok.unpricedTokens).toBe(0);
        expect(usage.summary().providers.codex.unpricedTokens).toBe(110);
    });

    it('keeps a fixed cutoff and excludes nested accounting agents', () => {
        const usage = new DevelopmentUsage(AT);
        usage.claude({ ...claude(), timestamp: LATER });
        expect(usage.summary().providers.claude.tokens).toBe(0);
        const metadata = new Map([
            ['root', {}],
            ['child', { parent: 'root' }],
            ['grandchild', { parent: 'child' }],
            ['other', {}],
        ]);
        expect(
            [...excludedDescendants(metadata, 'root')].toSorted((left, right) =>
                left.localeCompare(right),
            ),
        ).toEqual(['child', 'grandchild', 'root']);
    });

    it('updates only its README block and emits no identities or source content', () => {
        const usage = new DevelopmentUsage(CUTOFF);
        usage.claude(claude('PRIVATE_MESSAGE_ID'));
        const summary = usage.summary();
        const once = updateDevelopmentUsageReadme('# Example\n', summary);
        const twice = updateDevelopmentUsageReadme(once, summary);
        expect(twice).toBe(once);
        expect(twice).toContain('| Claude Code | 110 |');
        expect(twice).not.toMatch(/PRIVATE_MESSAGE_ID|SYNTHETIC_PRIVATE_CONTENT|\/workspace/);
        expect(renderDevelopmentUsage(summary)).toContain('standard API list-price equivalents');
        expect(() =>
            updateDevelopmentUsageReadme('<!-- development-usage:start -->', summary),
        ).toThrow('markers');
    });

    it('matches repository and auxiliary roots without matching unrelated names', () => {
        expect(isProjectCwd('/workspace/caxri-worktrees/topic')).toBe(true);
        expect(isProjectCwd('/workspace/Caxri/caxri-bot')).toBe(true);
        expect(isProjectCwd('/workspace/not-caxri')).toBe(false);
        expect(expandHome('~/backups', '/example-home')).toBe('/example-home/backups');
    });
});

describe('local source collection', () => {
    it('preserves Unicode separators, split UTF-8, CRLF and an unterminated final record', async () => {
        const first = JSON.stringify({ content: 'before\u{2028}middle\u{2029}after' });
        const final = JSON.stringify({ content: 'final' });
        const bytes = Buffer.from(`${first}\r\n${final}`);
        const separator = bytes.indexOf(Buffer.from('\u{2028}'));
        const chunks = [bytes.subarray(0, separator + 1), bytes.subarray(separator + 1)];
        const output: string[] = await Array.fromAsync(jsonlLines(Readable.from(chunks)));
        expect(output).toEqual([first, final]);
        expect(JSON.parse(output[0])).toEqual({ content: 'before\u{2028}middle\u{2029}after' });
    });

    it('finds project usage in rollouts that started elsewhere and preserves final Claude usage', async () => {
        const home = await mkdtemp(join(tmpdir(), 'development-usage-'));
        folders.push(home);
        await fixtureFile(home, '.codex/sessions/moved.jsonl', [
            { type: 'session_meta', payload: { id: 'moved', cwd: '/workspace/other' } },
            context(),
            mirror('outside'),
            { type: 'turn_context', payload: { cwd: '/workspace/caxri' } },
            mirror('inside'),
            event(),
        ]);
        const final = claude('unicode-message', { output_tokens: 100 });
        record(final.message).content = 'before\u{2028}middle\u{2029}after';
        await fixtureFile(home, '.claude/projects/-workspace-other/session.jsonl', [
            claude('unicode-message'),
            final,
        ]);
        const summary = await collectDevelopmentUsage({ home, asOf: CUTOFF, claudeBackups: [] });
        expect(summary.providers.codex.tokens).toBe(110);
        expect(summary.providers.claude.tokens).toBe(200);
        expect(summary.coverage.malformedLines).toBeUndefined();
    });

    it('reads compressed Codex, deduplicated Claude backups and Grok coverage without touching sources', async () => {
        const home = await mkdtemp(join(tmpdir(), 'development-usage-'));
        folders.push(home);
        const meta = (id: string, parent?: string): JsonRecord => ({
            type: 'session_meta',
            payload: {
                id,
                cwd: '/workspace/caxri',
                source: parent
                    ? { subagent: { thread_spawn: { parent_thread_id: parent } } }
                    : 'cli',
            },
        });
        await fixtureFile(
            home,
            '.codex/sessions/rollout.jsonl.zst',
            [meta('included'), context(), mirror(), event()],
            true,
        );
        await fixtureFile(home, '.codex/sessions/excluded.jsonl', [
            meta('excluded'),
            context(),
            mirror('excluded-response'),
        ]);
        await fixtureFile(home, '.codex/sessions/child.jsonl', [
            meta('child', 'excluded'),
            context(),
            mirror('excluded-child-response'),
        ]);
        const relative = '-workspace-caxri/session.jsonl';
        await fixtureFile(home, `.claude/projects/${relative}`, [claude()]);
        await Promise.all(
            ['backup-a', 'backup-b', 'backup-c'].map((backup) =>
                fixtureFile(home, `${backup}/${relative}`, [claude()]),
            ),
        );
        await fixtureFile(home, 'backup-a/-workspace-caxri/session/subagents/child.jsonl', [
            claude('child-message'),
        ]);
        await symlink(join(home, 'backup-a'), join(home, 'backup-alias'));
        await fixtureFile(home, '.grok/sessions/measured/summary.json', [
            { info: { cwd: '/workspace/caxri' } },
        ]);
        await fixtureFile(home, '.grok/sessions/measured/updates.jsonl', [
            grok({ inputTokens: 100, outputTokens: 10, costUsdTicks: 1e10 }),
        ]);
        await fixtureFile(home, '.grok/sessions/unknown/summary.json', [
            { info: { cwd: '/workspace/caxri' } },
        ]);
        const before = await readFile(join(home, `.claude/projects/${relative}`), 'utf8');
        const options = {
            home,
            asOf: CUTOFF,
            excludedThreadId: 'excluded',
            claudeBackups: ['backup-a', 'backup-b', 'backup-c', 'backup-alias'].map((name) =>
                join(home, name),
            ),
        };
        const summary = await collectDevelopmentUsage(options);
        expect(summary.providers.codex.tokens).toBe(110);
        expect(summary.providers.claude.tokens).toBe(220);
        expect(summary.providers.grok).toMatchObject({ tokens: 110, knownCostUsd: 1 });
        expect(summary.coverage).toMatchObject({
            codexExcludedFiles: 2,
            grokSessionsWithoutUsage: 1,
            claudeFilesScanned: 5,
        });
        expect(JSON.stringify(summary)).not.toContain(home);
        expect(JSON.stringify(summary)).not.toMatch(
            /excluded-response|message-1|SYNTHETIC_PRIVATE_CONTENT/,
        );
        expect(await collectDevelopmentUsage(options)).toEqual(summary);
        expect(await readFile(join(home, `.claude/projects/${relative}`), 'utf8')).toBe(before);
    });
});
