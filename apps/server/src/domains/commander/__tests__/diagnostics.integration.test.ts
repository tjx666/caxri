import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultAppSettings, diagnosticsSnapshotSchema } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, onTestFinished } from 'vitest';

import { CaxriDatabase } from '../../db';
import type { StoredAgentDelegation } from '../../db/models/agent-delegations';
import { DiagnosticsService } from '../../diagnostics';

const PROMPT = 'synthetic-private-prompt';
const ANSWER = 'synthetic-private-answer';

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-commander-diagnostics-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    onTestFinished(async () => {
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    const logDirectory = join(directory, 'logs');
    await mkdir(logDirectory);
    const commanderProject = database.createProject(join(directory, 'commander'));
    const commanderSession = database.createSession(commanderProject.id, null).session;
    const commanderTerminal = database.createTerminal(commanderSession.id, 'codex', directory);
    /**
     * A Commander parked by `commander.stop`: the Terminal row remains, its processes do not.
     */
    database.updateTerminalState(commanderTerminal.id, 'detached');
    const userProject = database.createProject(join(directory, 'repository'));
    const delegatedSession = database.createSession(userProject.id, null).session;
    database.setAppState('agentCommander', {
        projectId: commanderProject.id,
        sessionId: commanderSession.id,
        terminalId: commanderTerminal.id,
        sessionIds: [delegatedSession.id],
    });
    const delegation = (
        delegationId: string,
        receipt: Partial<StoredAgentDelegation['receipt']>,
    ): StoredAgentDelegation => ({
        receipt: {
            delegationId,
            projectId: userProject.id,
            sessionId: delegatedSession.id,
            callerTerminalId: commanderTerminal.id,
            provider: 'claude',
            status: 'running',
            revision: 1,
            createdAt: 1_000,
            updatedAt: 1_000,
            ...receipt,
        },
        principal: { kind: 'human-cli', id: 'synthetic-owner' },
        input: {
            projectId: userProject.id,
            sessionId: delegatedSession.id,
            provider: 'claude',
            prompt: PROMPT,
        },
        fingerprint: 'synthetic-fingerprint',
        promptDigest: 'a'.repeat(64),
        frozenLaunch: { executable: 'claude', args: [] },
    });
    database.agentDelegations.insert(
        delegation('delegation-failed', {
            status: 'failed',
            failure: 'rate_limited',
            createdAt: 1_000,
            updatedAt: 4_000,
        }),
    );
    database.agentDelegations.insert({
        ...delegation('delegation-completed', {
            status: 'completed',
            createdAt: 2_000,
            updatedAt: 9_000,
        }),
        answer: {
            text: ANSWER,
            source: 'transcript',
            messageId: 'synthetic-message',
            truncated: false,
            byteLength: ANSWER.length,
        },
    });
    const logLine = (event: string, fields: Record<string, unknown>) =>
        JSON.stringify({
            timestamp: '2026-01-01T00:00:00.000Z',
            process: 'server-core',
            level: 'info',
            event,
            fields,
        });
    await writeFile(
        join(logDirectory, 'server-core.jsonl'),
        [
            logLine('agent_commander.completion_notice_delivered', { count: 2, waitMs: 100 }),
            // A batch written twice by `flushSync` racing the async drain must count once.
            logLine('agent_commander.completion_notice_delivered', { count: 2, waitMs: 100 }),
            logLine('agent_commander.completion_notice_delivered', { count: 1, waitMs: 300 }),
            logLine('agent_commander.completion_notice_delivery_failed', { reason: 'rejected' }),
            logLine('agent_commander.completion_notice_dropped', {
                reason: 'server_shutdown',
                count: 2,
            }),
            logLine('agent_commander.completion_notice_queued', { text: PROMPT }),
            '{"truncated',
        ].join('\n'),
    );
    const diagnostics = new DiagnosticsService(
        database,
        { path: join(logDirectory, 'server-core.jsonl') } as StructuredLogger,
        () => defaultAppSettings,
        () => 0,
        1,
    );
    return { commanderTerminal, delegatedSession, diagnostics };
}

describe('Agent Commander diagnostics snapshot', () => {
    it('reports Commander state, owned Sessions, recent tasks, and notice latency as IDs and enums only', async () => {
        const { commanderTerminal, delegatedSession, diagnostics } = await fixture();

        const snapshot = diagnosticsSnapshotSchema.parse(await diagnostics.snapshot());

        expect(snapshot.agentCommander).toEqual({
            state: 'stopped',
            terminalId: commanderTerminal.id,
            terminalProcessState: 'detached',
            agentProcessState: 'starting',
            sessionCount: 1,
            recentDelegations: [
                {
                    delegationId: 'delegation-completed',
                    sessionId: delegatedSession.id,
                    provider: 'claude',
                    status: 'completed',
                    isCommanderCaller: true,
                    createdAt: 2_000,
                    updatedAt: 9_000,
                    durationMs: 7_000,
                },
                {
                    delegationId: 'delegation-failed',
                    sessionId: delegatedSession.id,
                    provider: 'claude',
                    status: 'failed',
                    failure: 'rate_limited',
                    isCommanderCaller: true,
                    createdAt: 1_000,
                    updatedAt: 4_000,
                    durationMs: 3_000,
                },
            ],
            completionNotices: {
                deliveredBatches: 2,
                deliveredNotices: 3,
                droppedNotices: 2,
                averageWaitMs: 200,
                maximumWaitMs: 300,
                deliveryFailures: { rejected: 1, unconfirmed: 0 },
            },
        });
        const serialized = JSON.stringify(snapshot.agentCommander);
        expect(serialized).not.toContain(PROMPT);
        expect(serialized).not.toContain(ANSWER);
        for (const contentField of ['"prompt"', '"answer"', '"text"', '"input"', '"transcript"'])
            expect(serialized).not.toContain(contentField);
    });

    it('reports an absent Commander as stopped with empty counters', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-commander-diagnostics-empty-'));
        const database = new CaxriDatabase(join(directory, 'state.db'));
        onTestFinished(async () => {
            database.close();
            await rm(directory, { recursive: true, force: true });
        });
        const diagnostics = new DiagnosticsService(
            database,
            { path: join(directory, 'logs', 'server-core.jsonl') } as StructuredLogger,
            () => defaultAppSettings,
            () => 0,
            1,
        );

        expect((await diagnostics.snapshot()).agentCommander).toEqual({
            state: 'stopped',
            sessionCount: 0,
            recentDelegations: [],
            completionNotices: {
                deliveredBatches: 0,
                deliveredNotices: 0,
                droppedNotices: 0,
                deliveryFailures: { rejected: 0, unconfirmed: 0 },
            },
        });
    });
});
