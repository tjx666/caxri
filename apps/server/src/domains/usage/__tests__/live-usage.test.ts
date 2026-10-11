import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import type { CaxriDatabase } from '../../db';
import { LiveAgentUsage } from '../live-usage';
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
});
