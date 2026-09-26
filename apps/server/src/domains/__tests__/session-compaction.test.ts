import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { readAgentTranscript } from '../agents';
import { CompactionReadiness, defaultAgentEnvironment } from '../agents';
import { CaxriDatabase } from '../db';
import { SessionCompaction } from '../session-compaction';
import type { TerminalManager } from '../terminal';

const now = Date.parse('2026-01-01T01:00:00Z');
function transcript(ageMinutes = 1) {
    return {
        path: '/fixture/transcript.jsonl',
        exists: true,
        truncated: false,
        content: JSON.stringify({
            timestamp: new Date(now - ageMinutes * 60_000).toISOString(),
            type: 'event_msg',
            payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 150_000 } } },
        }),
    };
}
async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-batch-compact-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    onTestFinished(async () => {
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    const project = database.createProject(directory);
    const readiness = new CompactionReadiness();
    const add = () => {
        const { session, terminal } = database.createSession(project.id, 'codex');
        database.updateAgentMetadata(terminal!.id, {
            sessionId: `native-${terminal!.id}`,
            status: 'completed',
            provider: 'codex',
            observedAt: now,
            available: true,
        });
        readiness.input(terminal!.id, '\r');
        const base = {
            terminalId: terminal!.id,
            launchId: 'launch',
            agentTurnId: 'turn',
            provider: 'codex',
        } as const;
        readiness.observe({ ...base, phase: 'turnStarted' });
        readiness.observe({ ...base, phase: 'turnFinished' });
        return { session, terminal: terminal! };
    };
    const first = add();
    const readTranscript = vi.fn<typeof readAgentTranscript>(() => Promise.resolve(transcript()));
    const writeAgentExact = vi.fn<TerminalManager['writeAgentExact']>(
        (_id, _data, _launch, _origin, delivered) => {
            delivered?.(true);
            return true;
        },
    );
    const terminals = {
        agentLaunchId: vi.fn(() => 'launch'),
        agentProcessId: vi.fn(() => 42),
        writeAgentExact,
        dimensions: (): undefined => undefined,
    };
    const coordinator = {
        hasIdleProof: vi.fn(() => true),
        agentOperation: vi.fn<() => undefined>(() => {}),
        observeInput: vi.fn(() => true),
    };
    const service = new SessionCompaction({
        database,
        readiness,
        terminals,
        coordinator,
        environment: defaultAgentEnvironment(),
        now: () => now,
        readTranscript,
    });
    return { ...first, add, database, readiness, terminals, coordinator, readTranscript, service };
}

describe('batch compaction', () => {
    it('submits one native compact per eligible Session and does not repeat it', async () => {
        const f = await fixture();
        expect(await f.service.run()).toEqual({
            items: [{ sessionId: f.session.id, outcome: 'submitted' }],
            deferred: 0,
        });
        expect(f.terminals.writeAgentExact).toHaveBeenCalledWith(
            f.terminal.id,
            '/compact\r',
            'launch',
            'human',
            expect.any(Function),
        );
        expect((await f.service.run()).items[0]?.outcome).toBe('unsafe_input');
        expect(f.terminals.writeAgentExact).toHaveBeenCalledTimes(1);
    });
    it.each([30, 31, -1])(
        'does not spend tokens outside the estimated cache window (%i minutes)',
        async (age) => {
            const f = await fixture();
            f.readTranscript.mockResolvedValue(transcript(age));
            expect((await f.service.run()).items[0]?.outcome).toBe('cache_expired');
            expect(f.terminals.writeAgentExact).not.toHaveBeenCalled();
        },
    );
    it('skips preexisting drafts without even reading private history', async () => {
        const f = await fixture();
        f.readiness.input(f.terminal.id, 'draft');
        expect((await f.service.run()).items[0]?.outcome).toBe('unsafe_input');
        expect(f.readTranscript).not.toHaveBeenCalled();
    });
    it.each(['draft', 'restart', 'archive', 'identity'] as const)(
        'rechecks %s changes after the asynchronous transcript read',
        async (change) => {
            const f = await fixture();
            f.readTranscript.mockImplementation(() => {
                switch (change) {
                    case 'draft': {
                        f.readiness.input(f.terminal.id, 'draft');
                        break;
                    }
                    case 'restart': {
                        f.terminals.agentLaunchId.mockReturnValue('new-launch');
                        break;
                    }
                    case 'archive': {
                        f.database.archiveSession(f.session.id);
                        break;
                    }
                    case 'identity': {
                        f.database.updateAgentMetadata(f.terminal.id, {
                            sessionId: 'replacement',
                            provider: 'codex',
                            status: 'completed',
                            observedAt: now,
                            available: true,
                        });
                        // No default
                        break;
                    }
                }
                return Promise.resolve(transcript());
            });
            expect((await f.service.run()).items[0]?.outcome).toBe('changed');
            expect(f.terminals.writeAgentExact).not.toHaveBeenCalled();
        },
    );
    it('coalesces overlapping clicks and continues after one failed read', async () => {
        const f = await fixture();
        f.add();
        f.readTranscript.mockRejectedValueOnce(new Error('unavailable'));
        const [first, second] = await Promise.all([f.service.run(), f.service.run()]);
        expect(first).toEqual(second);
        expect(
            first.items
                .map(({ outcome }) => outcome)
                .toSorted((left, right) => left.localeCompare(right)),
        ).toEqual(['failed', 'submitted']);
        expect(f.terminals.writeAgentExact).toHaveBeenCalledTimes(1);
    });
    it('keeps provider rejection distinct from native completion', async () => {
        const f = await fixture();
        f.terminals.writeAgentExact.mockImplementation(
            (_id, _data, _launch, _origin, delivered) => {
                delivered?.(false);
                return true;
            },
        );
        expect((await f.service.run()).items[0]?.outcome).toBe('failed');
    });
});
