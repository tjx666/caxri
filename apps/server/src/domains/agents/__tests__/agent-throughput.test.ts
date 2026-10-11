import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CaxriDatabase } from '../../db/index';
import { AgentThroughputService } from '../agent-throughput';

const AGENT_SESSION_ID = 'abc-1234-5678-9012';
const BASE = Date.parse('2026-10-10T08:00:00.000Z');

function line(seconds: number, type: 'assistant' | 'user', id?: string): string {
    return `${JSON.stringify({
        timestamp: new Date(BASE + seconds * 1_000).toISOString(),
        type,
        message:
            type === 'user'
                ? { role: 'user', content: 'Run the tests' }
                : { id, model: 'claude-opus-5-5', usage: { output_tokens: 200 } },
    })}\n`;
}

describe('AgentThroughputService', () => {
    let home: string;
    let transcript: string;
    let getTerminal: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        home = await mkdtemp(join(tmpdir(), 'caxri-agent-throughput-'));
        const cwd = join(home, 'project');
        const directory = join(home, '.claude', 'projects', cwd.replaceAll(/[^a-z\d]/gi, '-'));
        await mkdir(directory, { recursive: true });
        transcript = join(directory, `${AGENT_SESSION_ID}.jsonl`);
        await writeFile(transcript, '');
        getTerminal = vi.fn(() => ({
            id: 't1',
            provider: 'claude',
            agentSessionId: AGENT_SESSION_ID,
            cwd,
        }));
    });

    afterEach(async () => {
        await rm(home, { force: true, recursive: true });
    });

    function service(): AgentThroughputService {
        return new AgentThroughputService({ getTerminal } as unknown as CaxriDatabase, {
            homeDirectory: home,
            variables: {},
        });
    }

    it('reports nothing for a Terminal without a bound Agent session', async () => {
        getTerminal.mockReturnValue({ id: 't1', cwd: home });
        expect(await service().read('t1')).toBeNull();
    });

    it('reports nothing before the first measured response', async () => {
        await appendFile(transcript, line(0, 'user'));
        expect(await service().read('t1')).toBeNull();
    });

    it('accumulates responses appended between polls', async () => {
        const instance = service();
        await appendFile(transcript, line(0, 'user') + line(4, 'assistant', 'msg-1'));
        expect((await instance.read('t1'))?.session).toEqual({
            durationMs: 4_000,
            outputTokens: 200,
            responseCount: 1,
        });
        await appendFile(transcript, line(10, 'user') + line(12, 'assistant', 'msg-2'));
        expect(await instance.read('t1')).toMatchObject({
            provider: 'claude',
            session: { durationMs: 6_000, outputTokens: 400, responseCount: 2 },
            turn: { durationMs: 2_000, outputTokens: 200, responseCount: 1 },
        });
    });

    it('drops totals from a transcript the provider rewrote', async () => {
        const instance = service();
        await appendFile(
            transcript,
            line(0, 'user') +
                line(4, 'assistant', 'msg-1') +
                line(10, 'user') +
                line(12, 'assistant', 'msg-2'),
        );
        expect((await instance.read('t1'))?.session.responseCount).toBe(2);
        await writeFile(transcript, line(0, 'user') + line(1, 'assistant', 'msg-3'));
        expect((await instance.read('t1'))?.session).toEqual({
            durationMs: 1_000,
            outputTokens: 200,
            responseCount: 1,
        });
    });
});
