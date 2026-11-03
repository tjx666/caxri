import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { agentDelegationSettingsSchema } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { retryDelegationId } from '../retry-support';
import { RETRY_PREFACE } from '../task-body';
import { fixture, reasonOf, started } from './retry.fixture';

describe('retry now: fresh', () => {
    it('starts over in a new Session as the delegating Agent, who can read the result', async () => {
        const { authority, database, failedTask, service, start, stored, directory } =
            await fixture();
        const failed = await failedTask();

        const result = started(await service.retries.retry(failed.id, 'fresh'));

        expect(result.delegationId).toBe(retryDelegationId(failed.id));
        expect(result.delegationId).toMatch(/^[\da-f-]{36}$/u);
        expect(result.sessionId).not.toBe(failed.sessionId);
        const retried = stored(result.delegationId);
        expect(retried.principal).toEqual(authority.principal);
        expect(retried.receipt.callerTerminalId).toBe(authority.callerTerminalId);
        expect(retried.receipt.retryOf).toBe(failed.id);
        expect(retried.rootDelegationId).toBe(result.delegationId);
        // The failed task and its Session are untouched apart from the claim.
        const original = stored(failed.id);
        expect(original.receipt).toMatchObject({
            status: 'failed',
            failure: 'quota_exhausted',
            retriedAs: result.delegationId,
        });
        expect(original.retryMode).toBe('fresh');
        expect(database.getSession(failed.sessionId)).toBeDefined();
        // The Agent that delegated the task waits on and reads the retry.
        expect(service.status(result.delegationId, authority).retryOf).toBe(failed.id);
        expect(start).toHaveBeenCalledTimes(2);
        const body = await readFile(
            join(directory, 'delegations', result.delegationId, 'task.md'),
            'utf8',
        );
        expect(body.startsWith(RETRY_PREFACE)).toBe(true);
        expect(body).toContain('Synthetic task');
        // The preface lives in the task file only, so the stored prompt does not repeat it on a later retry.
        expect(retried.input.prompt).toBe('Synthetic task');
    });

    it('carries the failed Session title and creator into the new Session', async () => {
        const { database, failedTask, service, callerTerminalId } = await fixture();
        const failed = await failedTask();

        const { sessionId } = started(await service.retries.retry(failed.id, 'fresh'));

        const created = database.getSession(sessionId)!;
        expect(created.title).toBe('Child work');
        expect(created.createdBySessionId).toBe(database.getTerminal(callerTerminalId)!.sessionId);
        expect(created.createdByRelation).toBe('delegated');
    });

    it('is idempotent for the same mode and refuses the other mode', async () => {
        const { failedTask, service, start } = await fixture();
        const failed = await failedTask();

        const first = await service.retries.retry(failed.id, 'fresh');
        const second = await service.retries.retry(failed.id, 'fresh');

        expect(second).toEqual(first);
        expect(start).toHaveBeenCalledTimes(2);
        expect(await reasonOf(service.retries.retry(failed.id, 'resume'))).toBe('already_retried');
    });

    it('shares one run between concurrent requests in the same mode', async () => {
        const { database, failedTask, service, start } = await fixture();
        const failed = await failedTask();
        const sessionsBefore = database.listSessions().length;

        const [one, two] = await Promise.all([
            service.retries.retry(failed.id, 'fresh'),
            service.retries.retry(failed.id, 'fresh'),
        ]);

        expect(two).toEqual(one);
        expect(start).toHaveBeenCalledTimes(2);
        expect(database.listSessions()).toHaveLength(sessionsBefore + 1);
    });

    it('lets only one mode through when both buttons race', async () => {
        const { database, failedTask, service } = await fixture();
        const failed = await failedTask();
        const sessionsBefore = database.listSessions().length;

        const settled = await Promise.allSettled([
            service.retries.retry(failed.id, 'fresh'),
            service.retries.retry(failed.id, 'resume'),
        ]);

        expect(settled.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
        expect(database.agentDelegations.all()).toHaveLength(2);
        // The loser created no Session.
        expect(database.listSessions().length).toBeLessThanOrEqual(sessionsBefore + 1);
    });

    it('releases the claim and the empty Session when admission refuses before the record exists', async () => {
        const { database, failedTask, service, stored, verifyLaunch } = await fixture();
        const failed = await failedTask();
        const sessionsBefore = database.listSessions().length;
        verifyLaunch.mockRejectedValueOnce(new Error('provider version refused'));

        await expect(service.retries.retry(failed.id, 'fresh')).rejects.toThrow(
            'provider version refused',
        );

        expect(stored(failed.id).receipt.retriedAs).toBeUndefined();
        expect(stored(failed.id).retryMode).toBeUndefined();
        expect(database.listSessions()).toHaveLength(sessionsBefore);
        expect((await service.retries.retry(failed.id, 'fresh')).delegationId).toBe(
            retryDelegationId(failed.id),
        );
    });

    it('keeps the claim once the new task exists, even when its launch fails', async () => {
        const { failedTask, service, start, stored } = await fixture();
        const failed = await failedTask();
        start.mockRejectedValueOnce(new Error('spawn failed'));

        const result = await service.retries.retry(failed.id, 'fresh');

        expect(stored(failed.id).receipt.retriedAs).toBe(result.delegationId);
        expect(stored(result.delegationId).receipt.status).toBe('failed');
    });

    it('copies depth, parent and caller turn instead of reading the live caller', async () => {
        const { database, failedTask, service, stored } = await fixture({
            delegationSettings: () => agentDelegationSettingsSchema.parse({ maxDepth: 4 }),
        });
        const failed = await failedTask();
        const parentId = randomUUID();
        const record = stored(failed.id);
        database.agentDelegations.save({
            ...record,
            callerTurnId: 'original-turn',
            receipt: { ...record.receipt, depth: 3, parentDelegationId: parentId },
        });

        const result = await service.retries.retry(failed.id, 'fresh');

        expect(stored(result.delegationId).receipt).toMatchObject({
            depth: 3,
            parentDelegationId: parentId,
        });
        expect(stored(result.delegationId).callerTurnId).toBe('original-turn');
    });

    it('binds the failed Session worktree Project and inode without preparing another', async () => {
        const { database, directory, failedTask, project, prepareWorktree, service } =
            await fixture();
        const failed = await failedTask();
        const worktreePath = join(directory, 'wt');
        await mkdir(worktreePath);
        const stats = await lstat(worktreePath, { bigint: true });
        const worktree = database.createProject(worktreePath, project.id);
        database.selectWorkbenchProject(failed.sessionId, worktree.id, {
            device: stats.dev.toString(),
            inode: stats.ino.toString(),
        });

        const { sessionId } = started(await service.retries.retry(failed.id, 'fresh'));

        expect(prepareWorktree).not.toHaveBeenCalled();
        expect(database.getSessionWorkbenchBinding(sessionId)).toMatchObject({
            projectId: project.id,
            workbenchRootProjectId: worktree.id,
            rootInode: stats.ino.toString(),
        });
    });

    it('refuses when the worktree directory is gone or was replaced', async () => {
        const { database, directory, failedTask, project, service, stored } = await fixture();
        const failed = await failedTask();
        const worktreePath = join(directory, 'wt');
        await mkdir(worktreePath);
        const worktree = database.createProject(worktreePath, project.id);
        database.selectWorkbenchProject(failed.sessionId, worktree.id, {
            device: '1',
            inode: '999999999',
        });

        expect(await reasonOf(service.retries.retry(failed.id, 'fresh'))).toBe('worktree_gone');
        await rm(worktreePath, { recursive: true });
        expect(await reasonOf(service.retries.retry(failed.id, 'fresh'))).toBe('worktree_gone');
        expect(stored(failed.id).receipt.retriedAs).toBeUndefined();
    });

    it("refuses a Caxri Bot's Session", async () => {
        const { database, failedTask, service } = await fixture();
        const failed = await failedTask();
        database.setAppState('caxriBot', {
            projectId: database.getSession(failed.sessionId)!.projectId,
            sessionId: failed.sessionId,
            terminalId: failed.terminal.id,
            sessionIds: [failed.sessionId],
        });

        expect(await reasonOf(service.retries.retry(failed.id, 'fresh'))).toBe('not_retryable');
    });

    it('refuses when the current settings resolve the preset to another provider', async () => {
        let provider: 'claude' | 'codex' = 'claude';
        const { authority, database, project, service, stored } = await fixture({
            delegationSettings: () =>
                agentDelegationSettingsSchema.parse({
                    presets: [{ name: 'review', provider, useWhen: 'Review' }],
                }),
        });
        const id = randomUUID();
        const receipt = await service.create(id, authority, {
            projectId: project.id,
            preset: 'review',
            prompt: 'Synthetic task',
            newSession: true,
            title: 'Review',
        });
        const record = stored(id);
        database.agentDelegations.save({
            ...record,
            receipt: { ...record.receipt, status: 'failed', failure: 'provider_failed' },
        });
        expect(receipt.provider).toBe('claude');
        provider = 'codex';

        expect(await reasonOf(service.retries.retry(id, 'fresh'))).toBe('not_retryable');
        expect(stored(id).receipt.retriedAs).toBeUndefined();
    });
});

describe('retry now: resume', () => {
    it('continues the same Session as a new receipt owned by the delegating Agent', async () => {
        const { authority, failedTask, resume, service, start, stored } = await fixture();
        const failed = await failedTask();

        const result = await service.retries.retry(failed.id, 'resume');

        expect(result).toEqual({
            status: 'started',
            delegationId: retryDelegationId(failed.id),
            sessionId: failed.sessionId,
        });
        const retried = stored(result.delegationId);
        expect(retried.principal).toEqual(authority.principal);
        expect(retried.receipt).toMatchObject({
            retryOf: failed.id,
            resumeFrom: failed.id,
            callerTerminalId: authority.callerTerminalId,
        });
        expect(stored(failed.id).retryMode).toBe('resume');
        expect(stored(failed.id).nextDelegationId).toBe(result.delegationId);
        expect(resume).toHaveBeenCalledTimes(1);
        expect(start).toHaveBeenCalledTimes(1);
        expect(service.status(result.delegationId, authority).retryOf).toBe(failed.id);
    });

    type Scenario = [
        string,
        string,
        (
            context: Awaited<ReturnType<typeof fixture>>,
            failed: { id: string; terminal: { id: string } },
        ) => void,
    ];
    const scenarios: Scenario[] = [
        [
            'launch_replaced',
            'target_changed',
            ({ state }) => {
                state.childLaunch = 'another';
            },
        ],
        [
            'input_epoch_moved',
            'human_input',
            ({ state }) => {
                state.epoch = 5;
            },
        ],
        [
            'provider_session_replaced',
            'session_changed',
            ({ database }, failed) =>
                database.rebindAgentSession(failed.terminal.id, 'claude', 'another-conversation'),
        ],
        [
            'no_terminal',
            'no_provider_session',
            ({ database, stored }, failed) => {
                const record = stored(failed.id);
                database.agentDelegations.save({
                    ...record,
                    receipt: { ...record.receipt, terminalId: undefined },
                });
            },
        ],
        [
            'target_lost',
            'target_changed',
            ({ database, stored }, failed) =>
                database.agentDelegations.save({ ...stored(failed.id), hasLostTarget: true }),
        ],
    ];

    it.each(scenarios)('maps the %s rejection to %s', async (_rejection, reason, setup) => {
        const context = await fixture();
        const failed = await context.failedTask();
        setup(context, failed);

        expect(await reasonOf(context.service.retries.retry(failed.id, 'resume'))).toBe(reason);
        expect(context.stored(failed.id).receipt.retriedAs).toBeUndefined();
    });

    it('reports resume as unsupported when this build cannot resume', async () => {
        const { failedTask, service } = await fixture({ hasResume: false });
        const failed = await failedTask();

        expect(await reasonOf(service.retries.retry(failed.id, 'resume'))).toBe(
            'resume_unsupported',
        );
    });

    it('does not let an ordinary resume or follow-up take a retried task', async () => {
        const { authority, failedTask, service, stored } = await fixture();
        const failed = await failedTask();
        const retried = await service.retries.retry(failed.id, 'resume');
        const record = stored(retried.delegationId);
        const another = randomUUID();

        const receipt = await service.create(another, authority, {
            projectId: record.input.projectId,
            sessionId: failed.sessionId,
            resumeFrom: failed.id,
            prompt: 'Synthetic ordinary resume',
        });

        expect(receipt).toMatchObject({ status: 'failed', failure: 'target_busy' });
    });
});
