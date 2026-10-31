import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { writeAntigravityConversation } from '../../agents/providers/antigravity/__tests__/fixtures/conversation-database';
import { usageKeyDigest } from '../parsers';
import { IncrementalUsageScan, scanUsage, UsageTranscriptLocator } from '../scanner';

const ID = '6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7';
const AT = Date.parse('2026-03-01T10:00:00.000Z') / 1000;

async function home(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-usage-agy-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    return directory;
}

const turns = [
    {
        prompt: 'first',
        reply: 'one',
        at: AT,
        model: 'gemini-3-flash',
        usage: { input: 1000, output: 200, cacheRead: 5000, reasoning: 150 },
    },
    {
        prompt: 'second',
        reply: 'two',
        at: AT + 120,
        model: 'gemini-3-flash',
        usage: { input: 300, output: 40 },
    },
];

describe('Antigravity usage', () => {
    it("counts every model call of a conversation's database in the hour it ran", async () => {
        const directory = await home();
        await writeAntigravityConversation(directory, { id: ID, cwd: '/workspace/app', turns });
        const locator = new UsageTranscriptLocator({ homeDirectory: directory, variables: {} });

        const files = await locator.locate({
            provider: 'antigravity',
            agentSessionId: ID,
            cwd: '/workspace/app',
        });
        expect(files?.main.path).toMatch(new RegExp(String.raw`conversations/${ID}\.db$`, 'u'));
        const record = await scanUsage('antigravity', files!);

        expect(record.models).toEqual(['gemini-3-flash']);
        // [hour, model, input, output, cacheRead, cacheWrite, cacheWrite1h, reasoning, contextFloorK]
        expect(record.tokens.map((bucket) => bucket.slice(2, 8))).toEqual([
            [1300, 240, 5000, 0, 0, 150],
        ]);
        expect(record.activity).toEqual([[Math.floor(AT / 3600) * 3600, 121_000]]);
    });

    it('re-reads the whole database on every advance instead of counting it twice', async () => {
        const directory = await home();
        await writeAntigravityConversation(directory, { id: ID, turns });
        const files = await new UsageTranscriptLocator({
            homeDirectory: directory,
            variables: {},
        }).locate({ provider: 'antigravity', agentSessionId: ID, cwd: '/workspace/app' });
        const scan = new IncrementalUsageScan('antigravity');
        await scan.advance(files!);
        await scan.advance(files!);
        expect(scan.toRecord().tokens.reduce((sum, bucket) => sum + bucket[2], 0)).toBe(1300);
    });

    it('skips a model call another transcript already counts', async () => {
        const directory = await home();
        await writeAntigravityConversation(directory, { id: ID, turns });
        const files = await new UsageTranscriptLocator({
            homeDirectory: directory,
            variables: {},
        }).locate({ provider: 'antigravity', agentSessionId: ID, cwd: '/workspace/app' });
        const first = usageKeyDigest('antigravity', `${ID}:0`);
        const record = await scanUsage('antigravity', files!, {
            isCountedElsewhere: (digest) => digest === first,
        });
        expect(record.tokens.reduce((sum, bucket) => sum + bucket[2], 0)).toBe(300);
        expect(record.keys).toHaveLength(2);
    });
});
