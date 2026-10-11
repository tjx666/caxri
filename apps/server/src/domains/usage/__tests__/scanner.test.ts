import { appendFile, mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import type { ClaudeTranscriptMisses, UsageTranscriptFiles } from '../scanner';
import { IncrementalUsageScan, scanUsage, UsageTranscriptLocator } from '../scanner';

const T0 = Date.parse('2026-03-01T10:00:00.000Z');
const HOUR_MS = 3_600_000;

function line(id: string, output: number, offsetMs = 0) {
    return `${JSON.stringify({
        type: 'assistant',
        timestamp: new Date(T0 + offsetMs).toISOString(),
        message: { id, model: 'claude-x', usage: { output_tokens: output } },
    })}\n`;
}

async function fixture(): Promise<UsageTranscriptFiles> {
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-usage-scan-'));
    const baseRoot = await realpath(temporary);
    onTestFinished(() => rm(baseRoot, { recursive: true, force: true }));
    const root = join(baseRoot, 'project');
    await mkdir(root);
    const path = join(root, 'conversation.jsonl');
    await writeFile(path, '');
    return { main: { baseRoot, root, path }, earlier: [], side: [], fingerprint: '', bornAt: T0 };
}

function codexTotals(offsetMs: number, input: number) {
    return `${JSON.stringify({
        timestamp: new Date(T0 + offsetMs).toISOString(),
        type: 'event_msg',
        payload: {
            type: 'token_count',
            info: {
                total_token_usage: {
                    input_tokens: input,
                    cached_input_tokens: 0,
                    output_tokens: 0,
                },
            },
        },
    })}\n`;
}

function outputTokens(scan: IncrementalUsageScan): number {
    return scan.toRecord().tokens.reduce((sum, bucket) => sum + bucket[3], 0);
}

describe('IncrementalUsageScan', () => {
    it('reads only appended records and waits for an unterminated line', async () => {
        const files = await fixture();
        const scan = new IncrementalUsageScan('claude');
        await writeFile(files.main.path, line('m1', 5));
        await scan.advance(files);
        expect(outputTokens(scan)).toBe(5);

        const partial = line('m2', 7, 1000);
        await appendFile(files.main.path, partial.slice(0, 20));
        await scan.advance(files);
        expect(outputTokens(scan)).toBe(5);

        await appendFile(files.main.path, partial.slice(20));
        await scan.advance(files);
        expect(outputTokens(scan)).toBe(12);
        expect(scan.toRecord().activity).toEqual([[T0 / 1000, 1000]]);
    });

    it('restarts from scratch when the transcript is rewritten shorter', async () => {
        const files = await fixture();
        const scan = new IncrementalUsageScan('claude');
        await writeFile(files.main.path, line('m1', 5) + line('m2', 6));
        await scan.advance(files);
        expect(outputTokens(scan)).toBe(11);

        await writeFile(files.main.path, line('m3', 2));
        await scan.advance(files);
        expect(outputTokens(scan)).toBe(2);
    });

    it("keeps a reverted Codex thread's earlier turns in the hours they happened", async () => {
        const files = await fixture();
        const original = { ...files.main, path: join(files.main.root, 'original.jsonl') };
        await writeFile(original.path, codexTotals(0, 100) + codexTotals(2 * HOUR_MS, 200));
        // The rollout written by the revert opens with the thread's running total, then continues it.
        await writeFile(
            files.main.path,
            codexTotals(5 * HOUR_MS, 200) + codexTotals(5 * HOUR_MS, 250),
        );

        const record = await scanUsage('codex', { ...files, earlier: [original] });

        expect(record.tokens.map(([hour, , input]) => [hour * 1000 - T0, input])).toEqual([
            [0, 100],
            [2 * HOUR_MS, 100],
            [5 * HOUR_MS, 50],
        ]);
    });
});

describe('UsageTranscriptLocator', () => {
    const CONVERSATION = '0b6a1f8e-2c3d-4e5f-8a9b-1c2d3e4f5a6b';

    async function claudeHome() {
        const temporary = await mkdtemp(join(tmpdir(), 'caxri-usage-locate-'));
        const home = await realpath(temporary);
        onTestFinished(() => rm(home, { recursive: true, force: true }));
        const projects = join(home, '.claude', 'projects');
        await mkdir(join(projects, '-work-other'), { recursive: true });
        return { environment: { homeDirectory: home, variables: {} }, projects };
    }

    it('skips the cross-project search for a recently missing conversation until its directory changes', async () => {
        const { environment, projects } = await claudeHome();
        const target = {
            provider: 'claude' as const,
            agentSessionId: CONVERSATION,
            cwd: '/work/gone',
        };
        const misses: ClaudeTranscriptMisses = new Map();
        let now = T0;
        await utimes(projects, T0 / 1000, T0 / 1000);

        expect(
            await new UsageTranscriptLocator(environment, misses, () => now).locate(target),
        ).toBeUndefined();
        const repeat = new UsageTranscriptLocator(environment, misses, () => now);
        expect(await repeat.locate(target)).toBeUndefined();
        expect(repeat.skippedSearches).toBe(1);

        // The conversation resumed in another working directory: its new project directory changes the base mtime.
        await mkdir(join(projects, '-work-moved'));
        await writeFile(join(projects, '-work-moved', `${CONVERSATION}.jsonl`), '');
        await utimes(projects, T0 / 1000 + 60, T0 / 1000 + 60);
        const found = await new UsageTranscriptLocator(environment, misses, () => now).locate(
            target,
        );
        expect(found?.main.path).toBe(join(projects, '-work-moved', `${CONVERSATION}.jsonl`));
        expect(misses.size).toBe(0);

        // A miss expires after an hour even when the directory did not change.
        const missing = { ...target, agentSessionId: '1b6a1f8e-2c3d-4e5f-8a9b-1c2d3e4f5a6b' };
        await new UsageTranscriptLocator(environment, misses, () => now).locate(missing);
        now += HOUR_MS;
        const later = new UsageTranscriptLocator(environment, misses, () => now);
        await later.locate(missing);
        expect(later.skippedSearches).toBe(0);
    });
});
