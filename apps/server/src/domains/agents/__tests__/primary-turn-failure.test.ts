import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TerminalRecord } from '@caxri/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CaxriDatabase } from '../../db';
import type { AgentLifecycleSignal } from '../hooks/contract';
import { reconcilePrimaryTurnFailure } from '../primary-turn-failure';

function databaseWith(
    terminal: Partial<TerminalRecord> | undefined | (() => Partial<TerminalRecord> | undefined),
): CaxriDatabase {
    return {
        getTerminal: typeof terminal === 'function' ? terminal : () => terminal,
    } as unknown as CaxriDatabase;
}

describe('reconcilePrimaryTurnFailure', () => {
    let home: string;
    let cwd: string;

    beforeEach(async () => {
        home = await mkdtemp(join(tmpdir(), 'caxri-primary-turn-failure-'));
        cwd = join(home, 'project');
    });

    afterEach(async () => {
        await rm(home, { force: true, recursive: true });
    });

    function environment() {
        return { homeDirectory: home, variables: {} };
    }

    const baseSignal: AgentLifecycleSignal = {
        provider: 'codex',
        phase: 'turnFinished',
        terminalId: 't1',
        launchId: 'launch-1',
        agentTurnId: 'synthetic-turn',
    };

    async function writeCodexRollout(sessionId: string, content: string): Promise<void> {
        const date = new Date(0x019e676d8740);
        const day = [
            String(date.getFullYear()),
            String(date.getMonth() + 1).padStart(2, '0'),
            String(date.getDate()).padStart(2, '0'),
        ];
        const directory = join(home, '.codex', 'sessions', ...day);
        await mkdir(directory, { recursive: true });
        await writeFile(
            join(directory, `rollout-${day.join('-')}T11-14-52-${sessionId}.jsonl`),
            content,
        );
    }

    it('leaves a signal that is not an accepted turnFinished untouched, without reading anything', async () => {
        const database = databaseWith(() => {
            throw new Error(
                'must not read the terminal for a phase this function never reconciles',
            );
        });
        await expect(
            reconcilePrimaryTurnFailure(database, environment(), {
                ...baseSignal,
                phase: 'turnStarted',
            }),
        ).resolves.toEqual({ ...baseSignal, phase: 'turnStarted' });
        await expect(
            reconcilePrimaryTurnFailure(database, environment(), {
                ...baseSignal,
                agentTurnId: undefined,
            }),
        ).resolves.toEqual({ ...baseSignal, agentTurnId: undefined });
    });

    it('is a no-op for a provider whose own hooks already classify failure (claude, grok)', async () => {
        const database = databaseWith(() => {
            throw new Error(
                'must not read the transcript for a provider with no resolvePrimaryTurnFailure',
            );
        });
        const claudeSignal = { ...baseSignal, provider: 'claude' as const };
        await expect(
            reconcilePrimaryTurnFailure(database, environment(), claudeSignal),
        ).resolves.toBe(claudeSignal);
    });

    it('reclassifies a Codex primary turn that ended in an unambiguous provider error', async () => {
        const id = '019e676d-8740-7bb2-8bcb-f189c8260607';
        await writeCodexRollout(
            id,
            JSON.stringify({
                type: 'event_msg',
                payload: {
                    type: 'task_complete',
                    turn_id: baseSignal.agentTurnId,
                    last_agent_message: null,
                    error: {
                        codex_error_info: 'unauthorized',
                        message: 'Synthetic private diagnostic',
                    },
                },
            }),
        );
        const database = databaseWith({ id: 't1', provider: 'codex', agentSessionId: id, cwd });
        await expect(
            reconcilePrimaryTurnFailure(database, environment(), baseSignal),
        ).resolves.toEqual({
            ...baseSignal,
            phase: 'turnFailed',
            agentFailure: 'authentication_failed',
        });
    });

    it('keeps an ordinary completed Codex turn as turnFinished', async () => {
        const id = '019e676d-8740-7bb2-8bcb-f189c8260608';
        await writeCodexRollout(
            id,
            JSON.stringify({
                type: 'event_msg',
                payload: {
                    type: 'task_complete',
                    turn_id: baseSignal.agentTurnId,
                    last_agent_message: 'Final synthetic answer',
                },
            }),
        );
        const database = databaseWith({ id: 't1', provider: 'codex', agentSessionId: id, cwd });
        await expect(
            reconcilePrimaryTurnFailure(database, environment(), baseSignal),
        ).resolves.toEqual(baseSignal);
    });

    it('keeps the signal unchanged when the transcript cannot be read (missing, unbound, or a lookup failure)', async () => {
        const unbound = databaseWith({
            id: 't1',
            provider: 'codex',
            agentSessionId: undefined,
            cwd,
        });
        await expect(
            reconcilePrimaryTurnFailure(unbound, environment(), baseSignal),
        ).resolves.toEqual(baseSignal);
        const throwing = databaseWith(() => {
            throw new Error('synthetic lookup failure');
        });
        await expect(
            reconcilePrimaryTurnFailure(throwing, environment(), baseSignal),
        ).resolves.toEqual(baseSignal);
    });
});
