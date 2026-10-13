import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import type { CaxriDatabase } from '../../db';
import { LiveAgentUsage, newerUsageLimit } from '../live-usage';
import type { ModelPrice } from '../pricing';

const T0 = Date.parse('2026-03-01T10:00:00.000Z');
const FIRST = '0b6a1f8e-2c3d-4e5f-8a9b-1c2d3e4f5a6b';
const PRICE: ModelPrice = [1e-6, 2e-6, null, null, null];
const SECOND = '1b6a1f8e-2c3d-4e5f-8a9b-1c2d3e4f5a6b';

function line(id: string, output: number) {
    return `${JSON.stringify({
        type: 'assistant',
        timestamp: new Date(T0).toISOString(),
        message: { id, model: 'claude-x', usage: { input_tokens: 10, output_tokens: output } },
    })}\n`;
}

async function claudeProject() {
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-live-usage-'));
    const home = await realpath(temporary);
    onTestFinished(() => rm(home, { recursive: true, force: true }));
    const directory = join(home, '.claude', 'projects', '-work-app');
    await mkdir(directory, { recursive: true });
    return { environment: { homeDirectory: home, variables: {} }, directory };
}

function boundTerminal(binding: { agentSessionId?: string }) {
    return {
        getTerminal: () => ({ provider: 'claude', cwd: '/work/app', ...binding }),
    } as unknown as CaxriDatabase;
}

describe('LiveAgentUsage', () => {
    it('totals and prices the bound conversation, reading only what was appended', async () => {
        const { environment, directory } = await claudeProject();
        const path = join(directory, `${FIRST}.jsonl`);
        await writeFile(path, line('m1', 5));
        const usage = new LiveAgentUsage(
            boundTerminal({ agentSessionId: FIRST }),
            environment,
            () => PRICE,
            () => T0,
        );

        const first = await usage.read('terminal-1');
        expect(first).toMatchObject({ provider: 'claude', models: ['claude-x'] });
        expect(first?.tokens.output).toBe(5);

        await appendFile(path, line('m2', 7));
        const second = await usage.read('terminal-1');
        expect(second?.tokens.output).toBe(12);
        expect(second?.tokens.input).toBe(20);
        expect(second?.costUsd).toBeCloseTo(20e-6 + 24e-6);
        expect(second?.unpricedModels).toEqual([]);
    });

    it('starts over when the Terminal binds another conversation', async () => {
        const { environment, directory } = await claudeProject();
        await writeFile(join(directory, `${FIRST}.jsonl`), line('m1', 5));
        await writeFile(join(directory, `${SECOND}.jsonl`), line('m9', 3));
        const binding = { agentSessionId: FIRST };
        const usage = new LiveAgentUsage(
            boundTerminal(binding),
            environment,
            () => {},
            () => T0,
        );

        expect((await usage.read('terminal-1'))?.tokens.output).toBe(5);
        binding.agentSessionId = SECOND;
        expect((await usage.read('terminal-1'))?.tokens.output).toBe(3);
    });

    it('reports nothing for an unbound Terminal, a missing transcript, or one without usage', async () => {
        const { environment, directory } = await claudeProject();
        const unbound = new LiveAgentUsage(boundTerminal({}), environment, () => {});
        expect(await unbound.read('terminal-1')).toBeNull();

        const missing = new LiveAgentUsage(
            boundTerminal({ agentSessionId: SECOND }),
            environment,
            () => {},
        );
        expect(await missing.read('terminal-1')).toBeNull();

        await writeFile(join(directory, `${FIRST}.jsonl`), '');
        const empty = new LiveAgentUsage(
            boundTerminal({ agentSessionId: FIRST }),
            environment,
            () => {},
        );
        expect(await empty.read('terminal-1')).toBeNull();
    });

    it('reports the newest account-wide limit observed anywhere, not only this conversation', async () => {
        const { environment, directory } = await claudeProject();
        await writeFile(join(directory, `${FIRST}.jsonl`), line('m1', 5));
        const usage = new LiveAgentUsage(
            boundTerminal({ agentSessionId: FIRST }),
            environment,
            () => {},
            () => T0,
        );
        expect((await usage.read('terminal-1'))?.limit).toBeUndefined();

        const older = {
            provider: 'claude' as const,
            observedAt: T0 - 60_000,
            windows: [{ windowMinutes: 300, usedPercent: 20 }],
        };
        const newer = {
            ...older,
            observedAt: T0,
            windows: [{ windowMinutes: 300, usedPercent: 64 }],
        };
        usage.observeLimits([newer]);
        usage.observeLimits([older]);
        expect((await usage.read('terminal-1'))?.limit).toEqual(newer);
    });
});

describe('LiveAgentUsage.readTask', () => {
    async function subagent(directory: string, name: string, toolUseId: string, body: string) {
        const root = join(directory, FIRST, 'subagents');
        await mkdir(root, { recursive: true });
        await writeFile(join(root, `${name}.meta.json`), JSON.stringify({ toolUseId }));
        await writeFile(join(root, `${name}.jsonl`), body);
        return join(root, `${name}.jsonl`);
    }

    it('prices each subagent from its own side file, leaving units it repeats from its parent with the parent', async () => {
        const { environment, directory } = await claudeProject();
        await writeFile(join(directory, `${FIRST}.jsonl`), line('m1', 5));
        // A forked subagent's side file repeats the parent message that spawned it.
        const forked = await subagent(
            directory,
            'agent-a1',
            'toolu_a',
            line('m1', 5) + line('s1', 7),
        );
        await subagent(directory, 'agent-b2', 'toolu_b', line('s2', 11));
        const usage = new LiveAgentUsage(
            boundTerminal({ agentSessionId: FIRST }),
            environment,
            () => PRICE,
            () => T0,
        );

        const first = await usage.readTask('terminal-1', 'toolu_a');
        expect(first).toMatchObject({ provider: 'claude', models: ['claude-x'] });
        expect(first?.tokens).toMatchObject({ input: 10, output: 7 });
        expect(first?.costUsd).toBeCloseTo(10e-6 + 14e-6);
        expect((await usage.readTask('terminal-1', 'toolu_b'))?.tokens.output).toBe(11);
        expect((await usage.read('terminal-1'))?.tokens.output).toBe(5 + 7 + 11);

        await appendFile(forked, line('s3', 2));
        expect((await usage.readTask('terminal-1', 'toolu_a'))?.tokens.output).toBe(9);
    });

    it('reports nothing for an unknown task or a provider without subagent transcripts', async () => {
        const { environment, directory } = await claudeProject();
        await writeFile(join(directory, `${FIRST}.jsonl`), line('m1', 5));
        await subagent(directory, 'agent-a1', 'toolu_a', line('s1', 7));
        const usage = new LiveAgentUsage(
            boundTerminal({ agentSessionId: FIRST }),
            environment,
            () => PRICE,
            () => T0,
        );
        expect(await usage.readTask('terminal-1', 'toolu_missing')).toBeNull();

        const codex = new LiveAgentUsage(
            {
                getTerminal: () => ({ provider: 'codex', cwd: '/work/app', agentSessionId: FIRST }),
            } as unknown as CaxriDatabase,
            environment,
            () => PRICE,
            () => T0,
        );
        expect(await codex.readTask('terminal-1', 'toolu_a')).toBeNull();
    });
});

describe('newerUsageLimit', () => {
    const limit = (observedAt: number) => ({ provider: 'codex' as const, observedAt, windows: [] });

    it('keeps the later observation and the current one on a tie', () => {
        const current = limit(10);
        expect(newerUsageLimit(undefined, current)).toBe(current);
        expect(newerUsageLimit(current, limit(5))).toBe(current);
        expect(newerUsageLimit(current, limit(10))).toBe(current);
        expect(newerUsageLimit(current, limit(11)).observedAt).toBe(11);
    });
});
