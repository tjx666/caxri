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
    const directory = await mkdtemp(join(tmpdir(), 'caxri-bot-diagnostics-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    onTestFinished(async () => {
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    const logDirectory = join(directory, 'logs');
    await mkdir(logDirectory);
    const botProject = database.createProject(join(directory, 'bot'));
    const botSession = database.createSession(botProject.id, null).session;
    const botTerminal = database.createTerminal(botSession.id, 'codex', directory);
    /**
     * A Caxri Bot parked by `bot.stop`: the Terminal row remains, its processes do not.
     */
    database.updateTerminalState(botTerminal.id, 'detached');
    const userProject = database.createProject(join(directory, 'repository'));
    const delegatedSession = database.createSession(userProject.id, null).session;
    database.setAppState('caxriBot', {
        projectId: botProject.id,
        sessionId: botSession.id,
        terminalId: botTerminal.id,
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
            callerTerminalId: botTerminal.id,
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
    database.botPendingNotices.putDelegation({
        delegationId: 'delegation-completed',
        sessionId: delegatedSession.id,
        status: 'completed',
        revision: 2,
        queuedAt: 9_000,
    });
    database.botPendingNotices.markTurnStarted(9_500);
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
            logLine('caxri_bot.completion_notice_delivered', { count: 2, waitMs: 100 }),
            // A batch written twice by `flushSync` racing the async drain must count once.
            logLine('caxri_bot.completion_notice_delivered', { count: 2, waitMs: 100 }),
            logLine('caxri_bot.completion_notice_delivered', { count: 1, waitMs: 300 }),
            logLine('caxri_bot.completion_notice_delivery_failed', { reason: 'rejected' }),
            logLine('caxri_bot.resume_prompt_delivered', {
                count: 2,
                interruptedTurn: true,
                waitMs: 50,
            }),
            logLine('caxri_bot.completion_notice_queued', { text: PROMPT }),
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
    return { botTerminal, delegatedSession, diagnostics };
}

describe('Caxri Bot diagnostics snapshot', () => {
    it('reports Caxri Bot state, owned Sessions, recent tasks, and notice latency as IDs and enums only', async () => {
        const { botTerminal, delegatedSession, diagnostics } = await fixture();

        const snapshot = diagnosticsSnapshotSchema.parse(await diagnostics.snapshot());

        expect(snapshot.caxriBot).toEqual({
            state: 'stopped',
            terminalId: botTerminal.id,
            terminalProcessState: 'detached',
            agentProcessState: 'starting',
            sessionCount: 1,
            recentDelegations: [
                {
                    delegationId: 'delegation-completed',
                    sessionId: delegatedSession.id,
                    provider: 'claude',
                    status: 'completed',
                    isBotCaller: true,
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
                    isBotCaller: true,
                    createdAt: 1_000,
                    updatedAt: 4_000,
                    durationMs: 3_000,
                },
            ],
            completionNotices: {
                deliveredBatches: 2,
                deliveredNotices: 3,
                resumePrompts: 1,
                resumePromptNotices: 2,
                pendingNotices: 1,
                averageWaitMs: 200,
                maximumWaitMs: 300,
                deliveryFailures: { rejected: 1, unconfirmed: 0 },
            },
        });
        const serialized = JSON.stringify(snapshot.caxriBot);
        expect(serialized).not.toContain(PROMPT);
        expect(serialized).not.toContain(ANSWER);
        for (const contentField of ['"prompt"', '"answer"', '"text"', '"input"', '"transcript"'])
            expect(serialized).not.toContain(contentField);
    });

    it('reports an absent Caxri Bot as stopped with empty counters', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-bot-diagnostics-empty-'));
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

        expect((await diagnostics.snapshot()).caxriBot).toEqual({
            state: 'stopped',
            sessionCount: 0,
            recentDelegations: [],
            completionNotices: {
                deliveredBatches: 0,
                deliveredNotices: 0,
                resumePrompts: 0,
                resumePromptNotices: 0,
                pendingNotices: 0,
                deliveryFailures: { rejected: 0, unconfirmed: 0 },
            },
        });
    });
});
