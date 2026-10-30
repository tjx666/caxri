import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';

import type { AgentEnvironment, TranscriptScanFailureReason } from '../../agents';
import { discoverTranscripts, locateEarlierCodexRollouts } from '../../agents';
import { scanUsage, UsageTranscriptLocator } from '../scanner';

const T0 = Date.parse('2026-10-12T10:00:00.000Z');
const THREAD = '01a12f8e-0900-7000-8000-000000000001';
const REVERTED = '01a12f8e-0900-7000-8000-000000000002';
const ROLLOUT = '01a12f8e-0900-7000-8000-0000000000aa';
const STAMP = 'rollout-2026-10-12T10-00-00';

function totals(offsetMs: number, input: number): string {
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

describe('Usage of compressed Codex rollouts', () => {
    let day: string;
    let environment: AgentEnvironment;

    beforeEach(async () => {
        const temporary = await mkdtemp(join(tmpdir(), 'caxri-usage-zst-'));
        const home = await realpath(temporary);
        onTestFinished(() => rm(home, { recursive: true, force: true }));
        day = join(home, '.codex/sessions/2026/10/12');
        await mkdir(day, { recursive: true });
        environment = { homeDirectory: home, variables: {} };
    });

    const scanFirst = async (onFailure?: (reason: TranscriptScanFailureReason) => void) => {
        const [found] = await discoverTranscripts(environment, { includeCompressed: true });
        expect(found).toBeDefined();
        const files = await new UsageTranscriptLocator(environment).describe('codex', found.main);
        return scanUsage('codex', files!, { ...(onFailure && { onFailure }) });
    };

    it('counts a rollout stored only as .jsonl.zst like its plain equivalent', async () => {
        const content = totals(0, 100) + totals(1000, 250);
        await writeFile(join(day, `${STAMP}-${THREAD}.jsonl`), content);
        const plain = (await scanFirst()).tokens;
        await rm(join(day, `${STAMP}-${THREAD}.jsonl`));
        await writeFile(join(day, `${STAMP}-${THREAD}.jsonl.zst`), zstdCompressSync(content));
        expect(plain.length).toBeGreaterThan(0);
        expect((await scanFirst()).tokens).toEqual(plain);
    });

    it('discovers a plain rollout once when its compressed twin still exists', async () => {
        const content = totals(0, 100);
        await writeFile(join(day, `${STAMP}-${THREAD}.jsonl`), content);
        await writeFile(join(day, `${STAMP}-${THREAD}.jsonl.zst`), zstdCompressSync(content));
        const found = await discoverTranscripts(environment, { includeCompressed: true });
        expect(found.map((item) => item.main.path)).toEqual([
            join(day, `${STAMP}-${THREAD}.jsonl`),
        ]);
    });

    it('locates a hosted Session whose rollout was compressed, preferring the plain file', async () => {
        const zst = join(day, `${STAMP}-${THREAD}.jsonl.zst`);
        await writeFile(zst, zstdCompressSync(totals(0, 100)));
        const target = {
            provider: 'codex' as const,
            agentSessionId: THREAD,
            cwd: '/workspace/demo',
        };
        const compressed = await new UsageTranscriptLocator(environment).locate(target);
        expect(compressed?.main.path).toBe(zst);

        const plainPath = join(day, `${STAMP}-${THREAD}.jsonl`);
        await writeFile(plainPath, totals(0, 100));
        const both = await new UsageTranscriptLocator(environment).locate(target);
        expect(both?.main.path).toBe(plainPath);
    });

    it('finds compressed rollouts written before a revert', async () => {
        const earlier = join(day, `${STAMP}-${REVERTED}.jsonl.zst`);
        await writeFile(earlier, zstdCompressSync(totals(0, 100)));
        const currentPath = join(day, `rollout-2026-10-12T11-00-00-${REVERTED}_${ROLLOUT}.jsonl`);
        await writeFile(currentPath, totals(0, 300));
        const found = await locateEarlierCodexRollouts(
            { baseRoot: join(day, '..'), root: day, path: currentPath },
            environment,
        );
        expect(found.map((location) => location.path)).toEqual([earlier]);
    });

    it('reports a corrupt .jsonl.zst by closed reason without throwing', async () => {
        await writeFile(join(day, `${STAMP}-${THREAD}.jsonl.zst`), 'not zstandard');
        const reasons: string[] = [];
        const record = await scanFirst((reason) => reasons.push(reason));
        expect(record.tokens).toEqual([]);
        expect(reasons).toEqual(['decompressFailed']);
    });
});
