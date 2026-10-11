import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentDelegationReceipt } from '@caxri/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { CaxriDatabase } from '../../db';
import type { StoredAgentDelegation } from '../../db/models/agent-delegations';
import { CommanderTaskLedger, recordCommanderDelegation } from '../tasks';

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-commander-tasks-'));
    const databasePath = join(directory, 'state.db');
    let database = new CaxriDatabase(databasePath);
    onTestFinished(async () => {
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    const commanderProject = database.createProject(join(directory, 'commander'));
    const commanderSession = database.createSession(commanderProject.id, null).session;
    const commanderTerminal = database.createTerminal(commanderSession.id, 'codex', directory);
    const userProject = database.createProject(join(directory, 'repository'));
    const delegatedSession = database.createSession(userProject.id, null).session;
    database.setAppState('agentCommander', {
        projectId: commanderProject.id,
        sessionId: commanderSession.id,
        terminalId: commanderTerminal.id,
        sessionIds: [delegatedSession.id],
    });
    const receipt = (overrides: Partial<AgentDelegationReceipt> = {}): AgentDelegationReceipt => ({
        delegationId: 'delegation-1',
        projectId: userProject.id,
        sessionId: delegatedSession.id,
        callerTerminalId: commanderTerminal.id,
        provider: 'claude',
        status: 'running',
        revision: 1,
        createdAt: 1_000,
        updatedAt: 1_000,
        ...overrides,
    });
    const storeDelegation = (
        stored: AgentDelegationReceipt,
        extra: Partial<StoredAgentDelegation> = {},
    ) =>
        database.agentDelegations.insert({
            receipt: stored,
            principal: { kind: 'human-cli', id: 'synthetic-owner' },
            input: {
                projectId: stored.projectId,
                sessionId: stored.sessionId,
                provider: 'claude',
                prompt: 'synthetic prompt',
            },
            fingerprint: `fingerprint-${stored.delegationId}`,
            promptDigest: 'a'.repeat(64),
            frozenLaunch: { executable: 'claude', args: [] },
            ...extra,
        });
    let now = 10_000;
    const logger = { write: vi.fn() };
    const ledger = () => new CommanderTaskLedger(database, () => now, logger as never);
    return {
        database: () => database,
        delegatedSession,
        ledger,
        logger,
        receipt,
        reopen() {
            database.close();
            database = new CaxriDatabase(databasePath);
        },
        setNow(value: number) {
            now = value;
        },
        storeDelegation,
        userProject,
    };
}

describe('Commander task ledger', () => {
    it('keeps a task the Commander registered across a database reopen', async () => {
        const f = await fixture();
        const created = f.ledger().create({
            title: 'Fix the login redirect',
            projectId: f.userProject.id,
            note: 'Reported in chat',
        });
        expect(created).toMatchObject({ status: 'pending', projectId: f.userProject.id });

        f.reopen();

        expect(f.ledger().list({ includeClosed: false })).toEqual([created]);
    });

    it('rejects a Project the Commander cannot see', async () => {
        const f = await fixture();
        expect(() => f.ledger().create({ title: 'Task', projectId: 'missing-project' })).toThrow(
            /unavailable/,
        );
    });

    it('records a task on its own for a delegation the Commander sent without registering one', async () => {
        const f = await fixture();
        const sent = f.receipt();
        f.storeDelegation(sent);

        recordCommanderDelegation(f.database(), sent, undefined, 20_000, f.logger as never);
        // A later receipt for the same delegation, and an external caller, never add a row.
        recordCommanderDelegation(f.database(), sent, sent, 21_000);
        recordCommanderDelegation(
            f.database(),
            f.receipt({ delegationId: 'external', callerTerminalId: 'other-terminal' }),
            undefined,
            21_000,
        );

        expect(f.ledger().list({ includeClosed: true })).toMatchObject([
            {
                status: 'dispatched',
                delegationId: 'delegation-1',
                sessionId: f.delegatedSession.id,
                projectId: f.userProject.id,
                createdAt: 20_000,
            },
        ]);
        expect(f.logger.write).toHaveBeenCalledWith(
            'info',
            expect.stringContaining('task_recorded'),
            expect.objectContaining({
                fields: expect.objectContaining({ origin: 'delegation' }) as unknown,
            }),
        );
    });

    it('merges the automatically recorded row into the task the Commander links the delegation to', async () => {
        const f = await fixture();
        const task = f.ledger().create({ title: 'Ship the feature' });
        const sent = f.receipt();
        f.storeDelegation(sent);
        recordCommanderDelegation(f.database(), sent, undefined, 20_000);
        expect(f.ledger().list({ includeClosed: false })).toHaveLength(2);

        f.setNow(30_000);
        const linked = f.ledger().update({ taskId: task.id, delegationId: 'delegation-1' });

        expect(linked).toMatchObject({
            id: task.id,
            title: 'Ship the feature',
            status: 'dispatched',
            delegationId: 'delegation-1',
            sessionId: f.delegatedSession.id,
            projectId: f.userProject.id,
            updatedAt: 30_000,
        });
        expect(f.ledger().list({ includeClosed: true })).toEqual([linked]);
        expect(f.logger.write).toHaveBeenCalledWith(
            'info',
            expect.stringContaining('task_transitioned'),
            { fields: { taskId: task.id, from: 'pending', to: 'dispatched', ageMs: 20_000 } },
        );
    });

    it('links a follow-up to the root delegation of its chain', async () => {
        const f = await fixture();
        const root = f.receipt();
        f.storeDelegation(root);
        f.storeDelegation(f.receipt({ delegationId: 'delegation-2', followUpOf: 'delegation-1' }), {
            rootDelegationId: 'delegation-1',
        });
        const task = f.ledger().create({ title: 'Iterate' });

        expect(f.ledger().update({ taskId: task.id, delegationId: 'delegation-2' })).toMatchObject({
            delegationId: 'delegation-1',
        });
    });

    it('refuses to link a delegation another caller sent', async () => {
        const f = await fixture();
        f.storeDelegation(f.receipt({ callerTerminalId: 'other-terminal' }));
        const task = f.ledger().create({ title: 'Task' });

        expect(() => f.ledger().update({ taskId: task.id, delegationId: 'delegation-1' })).toThrow(
            /not one the Agent Commander sent/,
        );
    });

    it('moves a closed task out of the open list but keeps it for --all', async () => {
        const f = await fixture();
        const task = f.ledger().create({ title: 'Task' });
        f.ledger().update({
            taskId: task.id,
            status: 'done',
            pullRequestUrl: 'https://example.com/pull/1',
        });

        expect(f.ledger().list({ includeClosed: false })).toEqual([]);
        expect(f.ledger().list({ includeClosed: true })).toMatchObject([
            { id: task.id, status: 'done', pullRequestUrl: 'https://example.com/pull/1' },
        ]);
    });
});

describe('Commander pending notices', () => {
    it('keep one row per delegation and the interrupted turn across a database reopen', async () => {
        const f = await fixture();
        const notices = () => f.database().commanderPendingNotices;
        notices().putDelegation({
            delegationId: 'delegation-1',
            sessionId: f.delegatedSession.id,
            status: 'needsInput',
            revision: 2,
            queuedAt: 1_000,
        });
        notices().putDelegation({
            delegationId: 'delegation-1',
            sessionId: f.delegatedSession.id,
            status: 'completed',
            revision: 4,
            queuedAt: 5_000,
        });
        notices().markTurnStarted(3_000);

        f.reopen();

        expect(notices().list()).toEqual([
            {
                kind: 'delegation',
                delegationId: 'delegation-1',
                sessionId: f.delegatedSession.id,
                status: 'completed',
                revision: 4,
                queuedAt: 1_000,
            },
            { kind: 'interrupted_turn', queuedAt: 3_000 },
        ]);
        // The revision a launch prompt carried before the newer transition landed is not removed.
        notices().removeDelegations([{ delegationId: 'delegation-1', revision: 2 }]);
        expect(notices().list()).toHaveLength(2);
        notices().removeDelegations([{ delegationId: 'delegation-1', revision: 4 }]);
        // A marker set after the cutoff belongs to a later turn.
        notices().clearTurn(2_999);
        expect(notices().list()).toEqual([{ kind: 'interrupted_turn', queuedAt: 3_000 }]);
        notices().clearTurn();
        expect(notices().list()).toEqual([]);
    });
});
