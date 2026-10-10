import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import type { UsageTranscriptFiles } from '../scanner';
import { IncrementalUsageScan } from '../scanner';

const T0 = Date.parse('2026-03-01T10:00:00.000Z');

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
    return { main: { baseRoot, root, path }, side: [], fingerprint: '' };
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
});
