import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BootstrapState, Principal } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentDelegationService } from '../../agent-delegation';
import type { AgentEndpointLifecycle } from '../../agent-endpoints';
import type { AgentCoordinator } from '../../agents';
import { CaxriDatabase } from '../../db';
import { createDeletionHandlers } from '../../deletion-handlers';
import type { TerminalManager } from '../../terminal';
import { createTerminalMoveHandler } from '../../terminal/move';
import { createMobileAgentSubmitHandler } from '../agent-submit';
import { MobileTerminalMutationQueue } from '../terminal-mutation-queue';

const directories: string[] = [];
const endpoint = { hostId: 'host-1', endpointId: 'endpoint-1', generation: 1 };
const principal: Extract<Principal, { kind: 'paired-device' }> = {
    kind: 'paired-device',
    id: 'paired-device:device-1',
    deviceId: 'device-1',
    generation: 1,
    role: 'reply',
    projectIds: [],
};

afterEach(async () => {
    const previous = [...directories];
    directories.length = 0;
    await Promise.all(previous.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-mobile-submit-'));
    directories.push(directory);
    const path = join(directory, 'state.db');
    const database = new CaxriDatabase(path);
    const project = database.createProject(join(directory, 'project'));
    const other = database.createProject(join(directory, 'other'));
    const created = database.createSession(project.id, 'codex', project.rootPath);
    const sessionId = created.session.id;
    const terminalId = created.terminal!.id;
    database.updateTerminalState(terminalId, 'running');
    const submitAgentExact = vi.fn<TerminalManager['submitAgentExact']>(() =>
        Promise.resolve('accepted'),
    );
    const target = { launchId: 'launch-1', ref: endpoint, terminalId };
    const controlTarget = vi.fn(() => target);
    const isCurrent = vi.fn(() => true);
    const endpoints = { controlTarget, isCurrent } as unknown as AgentEndpointLifecycle;
    const queue = new MobileTerminalMutationQueue();
    const input = {
        sessionId,
        terminalId,
        endpoint,
        clientMutationId: 'mutation-1',
        text: '你好\ncontinue',
        principal: { ...principal, projectIds: [project.id] },
    };
    const handler = createMobileAgentSubmitHandler({
        database,
        endpoints,
        queue,
        terminals: { submitAgentExact },
    });
    return {
        database,
        endpoints,
        handler,
        input,
        other,
        path,
        queue,
        submitAgentExact,
        terminalId,
    };
}

describe('mobile Agent submission', () => {
    it('includes only resolved attachment paths in one exact Agent submission', async () => {
        const f = await fixture();
        const attachmentId = 'image_0123456789abcdef0123456789abcdef';
        const imagePath = join(f.path, `${attachmentId}.jpg`);
        const paths = vi.fn(() => [imagePath]);
        const handler = createMobileAgentSubmitHandler({
            database: f.database,
            endpoints: f.endpoints,
            images: { paths },
            queue: f.queue,
            terminals: { submitAgentExact: f.submitAgentExact },
        });
        const input = { ...f.input, attachmentIds: [attachmentId] };
        try {
            await expect(handler(input)).resolves.toEqual({
                terminalId: f.terminalId,
                outcome: 'accepted',
            });
            expect(paths).toHaveBeenCalledExactlyOnceWith('device-1:1', f.input.sessionId, [
                attachmentId,
            ]);
            expect(f.submitAgentExact).toHaveBeenCalledExactlyOnceWith(
                f.terminalId,
                f.input.sessionId,
                'launch-1',
                `${f.input.text}\n\nAttached image paths:\n${imagePath}`,
                undefined,
            );
            await expect(handler({ ...input, attachmentIds: [] })).rejects.toMatchObject({
                code: 'CONFLICT',
            });
        } finally {
            f.database.close();
        }
    });

    it('writes once and replays accepted after a Server database reopen without storing text', async () => {
        const f = await fixture();
        expect(await f.handler(f.input)).toEqual({ terminalId: f.terminalId, outcome: 'accepted' });
        expect(f.submitAgentExact).toHaveBeenCalledExactlyOnceWith(
            f.terminalId,
            f.input.sessionId,
            'launch-1',
            '你好\ncontinue',
            undefined,
        );
        f.database.close();
        const reopened = new CaxriDatabase(f.path);
        try {
            const replay = createMobileAgentSubmitHandler({
                database: reopened,
                endpoints: undefined,
                queue: f.queue,
                terminals: { submitAgentExact: f.submitAgentExact },
            });
            expect(await replay(f.input)).toEqual({
                terminalId: f.terminalId,
                outcome: 'accepted',
            });
            expect(f.submitAgentExact).toHaveBeenCalledOnce();
            const row = reopened.database
                .prepare('SELECT * FROM mobile_agent_submit_receipts')
                .get() as Record<string, unknown>;
            expect(JSON.stringify(row)).not.toContain('你好');
            await expect(replay({ ...f.input, text: 'changed' })).rejects.toMatchObject({
                code: 'CONFLICT',
            });
        } finally {
            reopened.close();
        }
    });

    it('keeps a reserved receipt unknown after an uncertain Host result and blocks duplicate writes', async () => {
        const f = await fixture();
        f.submitAgentExact.mockResolvedValueOnce('unknown');
        expect(await f.handler(f.input)).toEqual({ terminalId: f.terminalId, outcome: 'unknown' });
        f.database.close();
        const reopened = new CaxriDatabase(f.path);
        try {
            const replay = createMobileAgentSubmitHandler({
                database: reopened,
                endpoints: f.endpoints,
                queue: f.queue,
                terminals: { submitAgentExact: f.submitAgentExact },
            });
            expect(await replay(f.input)).toEqual({ terminalId: f.terminalId, outcome: 'unknown' });
            expect(f.submitAgentExact).toHaveBeenCalledOnce();
        } finally {
            reopened.close();
        }
    });

    it('cleans up a proven no-write rejection and binds a mutation ID to its endpoint', async () => {
        const f = await fixture();
        try {
            f.submitAgentExact.mockResolvedValueOnce('rejected');
            await expect(f.handler(f.input)).rejects.toMatchObject({ code: 'CONFLICT' });
            expect(await f.handler(f.input)).toEqual({
                terminalId: f.terminalId,
                outcome: 'accepted',
            });
            expect(f.submitAgentExact).toHaveBeenCalledTimes(2);
            await expect(
                f.handler({ ...f.input, endpoint: { ...endpoint, generation: 2 } }),
            ).rejects.toMatchObject({ code: 'CONFLICT' });
        } finally {
            f.database.close();
        }
    });

    it('waits for a delayed Host write before moving the Terminal to another Session', async () => {
        const f = await fixture();
        const host = Promise.withResolvers<'accepted'>();
        f.submitAgentExact.mockReturnValueOnce(host.promise);
        const reassignSession = vi.fn();
        const move = createTerminalMoveHandler({
            coordinator: {
                probeSessionPrimaryAgent: vi.fn(),
                probeTerminal: vi.fn(),
            } as unknown as AgentCoordinator,
            database: f.database,
            mobileTerminalMutations: f.queue,
            observeSelectedSession: vi.fn(),
            send: vi.fn(),
            terminals: { reassignSession } as unknown as TerminalManager,
        })['terminal.moveToNewSession'];
        try {
            const submitting = f.handler(f.input);
            await vi.waitFor(() => expect(f.submitAgentExact).toHaveBeenCalledOnce());
            const moving = move({ terminalId: f.terminalId });
            await Promise.resolve();
            expect(f.database.getTerminal(f.terminalId)?.sessionId).toBe(f.input.sessionId);
            expect(reassignSession).not.toHaveBeenCalled();
            host.resolve('accepted');
            await expect(submitting).resolves.toEqual({
                terminalId: f.terminalId,
                outcome: 'accepted',
            });
            const moved = await moving;
            expect(moved.session.id).not.toBe(f.input.sessionId);
            expect(f.database.getTerminal(f.terminalId)?.sessionId).toBe(moved.session.id);
            expect(reassignSession).toHaveBeenCalledExactlyOnceWith(f.terminalId, moved.session.id);
            expect(await f.handler(f.input)).toEqual({
                terminalId: f.terminalId,
                outcome: 'accepted',
            });
            expect(f.submitAgentExact).toHaveBeenCalledOnce();
        } finally {
            host.resolve('accepted');
            f.database.close();
        }
    });

    it('waits for a delayed Host write before deleting the owning Session', async () => {
        const f = await fixture();
        const host = Promise.withResolvers<'accepted'>();
        f.submitAgentExact.mockReturnValueOnce(host.promise);
        const evictSessions = vi.fn();
        const deleteSession = createDeletionHandlers({
            database: f.database,
            delegations: {
                deleteSessions: (_ids: readonly string[], remove: () => unknown) =>
                    Promise.resolve(remove()),
            } as unknown as AgentDelegationService,
            mobileTerminalMutations: f.queue,
            bootstrapState: () => ({}) as BootstrapState,
            forgetSessionRuntime: vi.fn(),
            evictSessions,
            projectDeleted: vi.fn(),
            restoreSelection: vi.fn(),
            send: vi.fn(),
        })['session.delete'];
        try {
            const submitting = f.handler(f.input);
            await vi.waitFor(() => expect(f.submitAgentExact).toHaveBeenCalledOnce());
            const deleting = deleteSession({ sessionId: f.input.sessionId });
            await Promise.resolve();
            expect(f.database.getSession(f.input.sessionId)).toBeDefined();
            expect(evictSessions).not.toHaveBeenCalled();
            host.resolve('accepted');
            await expect(submitting).resolves.toMatchObject({ outcome: 'accepted' });
            await deleting;
            expect(f.database.getSession(f.input.sessionId)).toBeUndefined();
            expect(evictSessions).toHaveBeenCalledOnce();
        } finally {
            host.resolve('accepted');
            f.database.close();
        }
    });

    it('includes a newly created Session when Project deletion waits for an in-flight Host write', async () => {
        const f = await fixture();
        const host = Promise.withResolvers<'accepted'>();
        f.submitAgentExact.mockReturnValueOnce(host.promise);
        const projectId = f.input.principal.projectIds[0];
        const deleteProject = createDeletionHandlers({
            database: f.database,
            delegations: {
                deleteSessions: (_ids: readonly string[], remove: () => unknown) =>
                    Promise.resolve(remove()),
            } as unknown as AgentDelegationService,
            mobileTerminalMutations: f.queue,
            bootstrapState: () => ({}) as BootstrapState,
            forgetSessionRuntime: vi.fn(),
            evictSessions: vi.fn(),
            projectDeleted: vi.fn(),
            restoreSelection: vi.fn(),
            send: vi.fn(),
        })['project.delete'];
        try {
            const submitting = f.handler(f.input);
            await vi.waitFor(() => expect(f.submitAgentExact).toHaveBeenCalledOnce());
            const deleting = deleteProject({ projectId });
            const created = f.database.createSession(
                projectId,
                'codex',
                f.database.getProject(projectId)!.rootPath,
            );
            const secondTerminalId = created.terminal!.id;
            f.database.updateTerminalState(secondTerminalId, 'running');
            const secondSubmission = createMobileAgentSubmitHandler({
                database: f.database,
                endpoints: {
                    controlTarget: () => ({
                        launchId: 'launch-2',
                        ref: endpoint,
                        terminalId: secondTerminalId,
                    }),
                    isCurrent: () => true,
                } as unknown as AgentEndpointLifecycle,
                queue: f.queue,
                terminals: { submitAgentExact: f.submitAgentExact },
            })({
                ...f.input,
                sessionId: created.session.id,
                terminalId: secondTerminalId,
                clientMutationId: 'mutation-2',
            });
            await Promise.resolve();
            expect(f.database.getSession(created.session.id)).toBeDefined();
            expect(f.submitAgentExact).toHaveBeenCalledOnce();
            host.resolve('accepted');
            await expect(submitting).resolves.toMatchObject({ outcome: 'accepted' });
            await deleting;
            await expect(secondSubmission).rejects.toMatchObject({ code: 'NOT_FOUND' });
            expect(f.database.getSession(created.session.id)).toBeUndefined();
            expect(f.submitAgentExact).toHaveBeenCalledOnce();
        } finally {
            host.resolve('accepted');
            f.database.close();
        }
    });

    it('rejects unauthorized Projects, a stale endpoint, and an exited Agent before writing', async () => {
        const f = await fixture();
        try {
            await expect(
                f.handler({
                    ...f.input,
                    principal: { ...f.input.principal, projectIds: [f.other.id] },
                }),
            ).rejects.toMatchObject({ code: 'NOT_FOUND' });
            await expect(
                f.handler({ ...f.input, principal: { ...f.input.principal, role: 'view' } }),
            ).rejects.toMatchObject({ code: 'FORBIDDEN' });
            vi.spyOn(f.endpoints, 'controlTarget').mockImplementationOnce(() => {
                throw new Error('stale endpoint');
            });
            await expect(f.handler(f.input)).rejects.toThrow('stale endpoint');
            f.database.updateTerminalState(f.terminalId, 'dead');
            await expect(f.handler(f.input)).rejects.toMatchObject({ code: 'CONFLICT' });
            expect(f.submitAgentExact).not.toHaveBeenCalled();
        } finally {
            f.database.close();
        }
    });
});
