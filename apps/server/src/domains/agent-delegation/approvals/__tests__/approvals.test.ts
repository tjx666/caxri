import { APPROVAL_ESCALATION_GRACE_MS, CaxriError, logEventCatalog } from '@caxri/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DelegationAuthority } from '../../admission';
import type { FileChange } from './approvals.fixture';
import {
    approvalFixture,
    command,
    conflictError,
    SECRET_COMMAND,
    SECRET_PATH,
} from './approvals.fixture';

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

const GRACE = APPROVAL_ESCALATION_GRACE_MS;
const fileChange = (paths: string[], id = 'req-1'): FileChange => ({
    id,
    kind: 'fileChange',
    paths,
});

const refusal = (run: () => unknown) => {
    try {
        run();
    } catch (error) {
        return error as CaxriError;
    }
    throw new Error('expected a refusal');
};

describe('a covered request', () => {
    it('is held quietly, decided by the delegating Agent, and leaves no timer behind', async () => {
        const f = await approvalFixture();

        expect(f.ask(command())).toBe('quiet');
        expect(f.database.agentDelegations.get(f.task.id)!.receipt.status).toBe('blocked');
        expect(f.approvals.viewFor(f.task.id)).toMatchObject({
            requestId: 'req-1',
            kind: 'command',
            covered: true,
            escalated: false,
            command: SECRET_COMMAND,
        });

        expect(f.decide('req-1', 'accept')).toEqual({ outcome: 'approved' });

        expect(f.provider.responses).toEqual([{ requestId: 'req-1', decision: 'accept' }]);
        expect(f.provider.raised).toEqual([]);
        expect(f.provider.items).toMatchObject([
            { type: 'notice', kind: 'delegationApproval', id: 'delegation-approval:req-1' },
        ]);
        expect(f.provider.changes.map((change) => change.state)).toEqual(['pending', 'decided']);
        expect(f.approvals.viewFor(f.task.id)).toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('declines a request, and refuses a decision the provider does not offer', async () => {
        const f = await approvalFixture();
        f.ask(command());
        f.provider.offers = { accept: true, decline: false };
        f.approvals.observe(f.child);

        expect(refusal(() => f.decide('req-1', 'decline')).code).toBe('VALIDATION');
        expect(f.provider.responses).toEqual([]);
        f.provider.offers = { accept: true, decline: true };
        f.approvals.observe(f.child);
        expect(f.decide('req-1', 'decline')).toEqual({ outcome: 'declined' });
    });

    it('hands the request to the user once the grace elapses, raising the held alert exactly once', async () => {
        const f = await approvalFixture();
        f.ask(command());

        f.elapse(GRACE - 1);
        expect(f.provider.raised).toEqual([]);
        f.elapse(1);

        expect(f.provider.raised).toHaveLength(1);
        expect(f.provider.raised[0]).toMatchObject({
            agentToolUseId: 'req-1',
            phase: 'attentionRequested',
        });
        expect(f.approvals.viewFor(f.task.id)).toMatchObject({ escalated: true });
        expect(f.logged(logEventCatalog.agentDelegation.approvalEscalated)).toMatchObject([
            { escalationReason: 'grace_elapsed' },
        ]);
        // Still approvable until the user answers first.
        expect(f.decide('req-1')).toEqual({ outcome: 'approved' });
        expect(f.provider.raised).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('never unblocks the task while another request is pending', async () => {
        const f = await approvalFixture();
        f.ask(command('req-1'));
        f.ask(command('req-2'));

        f.decide('req-1');
        f.service.observe({ ...f.base, phase: 'attentionResolved' });
        expect(f.database.agentDelegations.get(f.task.id)!.receipt.status).toBe('blocked');

        f.decide('req-2');
        f.service.observe({ ...f.base, phase: 'attentionResolved' });
        expect(f.database.agentDelegations.get(f.task.id)!.receipt.status).toBe('running');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('decides two concurrent requests independently and the same request only once', async () => {
        const f = await approvalFixture();
        f.ask(command('req-1'));
        f.ask(command('req-2'));

        const results = await Promise.allSettled([
            Promise.try(() => f.decide('req-1')),
            Promise.try(() => f.decide('req-2', 'decline')),
            Promise.try(() => f.decide('req-1')),
        ]);

        expect(results.map((result) => result.status)).toEqual([
            'fulfilled',
            'fulfilled',
            'rejected',
        ]);
        expect((results[2] as PromiseRejectedResult).reason).toMatchObject({ code: 'NOT_FOUND' });
        expect(f.provider.responses).toEqual([
            { requestId: 'req-1', decision: 'accept' },
            { requestId: 'req-2', decision: 'decline' },
        ]);
    });
});

describe('a request the delegating Agent does not cover', () => {
    it.each([
        ['acceptEdits mode for a command', 'parent_mode_insufficient'],
        ['an unapplied mode', 'parent_mode_unapplied'],
        ['plan mode', 'parent_plan_mode'],
    ])('alerts the user at once for %s and refuses with a reason', async (name, reason) => {
        const f = await approvalFixture();
        switch (reason) {
            case 'parent_mode_insufficient': {
                f.provider.permission.permissionMode = 'acceptEdits';
                break;
            }
            case 'parent_mode_unapplied': {
                f.provider.permission.applied = false;
                break;
            }
            case 'parent_plan_mode': {
                f.provider.permission.planMode = true;
                break;
            }
        }

        expect(f.ask(command()), name).toBe('alert');

        const error = refusal(() => f.decide('req-1'));
        expect(error).toMatchObject({ code: 'FORBIDDEN', details: { coverageReason: reason } });
        expect(f.provider.responses).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
        ['absent', undefined],
        ['empty-looking', { accept: false, decline: false }],
        ['unknown-only', { accept: false, decline: true }],
    ])('does not cover a request whose offered decisions are %s', async (_name, offers) => {
        const f = await approvalFixture();
        f.provider.offers = offers;

        expect(f.ask(command())).toBe('alert');
        expect(refusal(() => f.decide('req-1')).details).toMatchObject({
            coverageReason: 'accept_not_offered',
        });
    });

    it('does not cover a tool request, a question, or a network request', async () => {
        const f = await approvalFixture();

        expect(f.ask({ id: 't1', kind: 'tool', name: 'WebFetch' })).toBe('alert');
        expect(f.ask({ id: 'q1', kind: 'question', questions: [] })).toBe('alert');
        expect(f.ask(command('c1', { networkHost: 'example.test' }))).toBe('alert');
        expect(f.approvals.feed([f.task.id]).get(f.task.id)).toMatchObject({ waitingOn: 'user' });
    });

    it('refuses a delegating Agent that no longer holds its permission, and shows the user', async () => {
        const f = await approvalFixture();
        f.ask(command());
        f.provider.permission.permissionMode = 'acceptEdits';

        expect(refusal(() => f.decide('req-1')).details).toMatchObject({
            coverageReason: 'parent_mode_insufficient',
        });
        expect(f.provider.raised).toHaveLength(1);
        expect(f.approvals.feed([f.task.id]).get(f.task.id)).toMatchObject({ waitingOn: 'user' });
    });
});

describe('a request changed under the same id', () => {
    it('is judged again and the first request time is kept so the grace never extends', async () => {
        const f = await approvalFixture();
        f.ask(command());
        f.elapse(GRACE - 1000);

        f.provider.requests = [command('req-1', { command: 'echo SECRET_CHANGED' })];
        expect(refusal(() => f.decide('req-1')).code).toBe('CONFLICT');
        expect(f.approvals.viewFor(f.task.id)).toMatchObject({ command: 'echo SECRET_CHANGED' });

        f.elapse(1000);
        expect(f.provider.raised).toHaveLength(1);
    });

    it('hands a request edited into network access to the user without a second alert', async () => {
        const f = await approvalFixture();
        f.ask(command());

        f.provider.requests = [command('req-1', { networkHost: 'example.test' })];
        f.approvals.observe(f.child);

        expect(f.provider.raised).toHaveLength(1);
        expect(refusal(() => f.decide('req-1')).details).toMatchObject({
            coverageReason: 'network',
        });
    });

    it('notices a changed offer for the same request', async () => {
        const f = await approvalFixture();
        f.ask(command());
        const { revision } = f.approvals.viewFor(f.task.id)!;
        f.provider.offers = { accept: false, decline: true };

        expect(refusal(() => f.decide('req-1', 'accept', undefined, revision)).code).toBe(
            'CONFLICT',
        );
        const reread = f.approvals.viewFor(f.task.id)!.revision;
        expect(reread).not.toBe(revision);
        expect(refusal(() => f.decide('req-1', 'accept', undefined, reread)).details).toMatchObject(
            {
                coverageReason: 'accept_not_offered',
            },
        );
    });
});

describe('a file change', () => {
    it('is provisionally covered while its path check runs, then decided once inside', async () => {
        const { promise: gate, resolve: release } = Promise.withResolvers<void>();
        const f = await approvalFixture(
            {},
            {
                pathResolver: async (_id, path) => (
                    await gate,
                    { root: '/workspace', workspacePath: path }
                ),
            },
        );
        expect(f.ask(fileChange(['/workspace/a.ts']))).toBe('quiet');
        expect(f.approvals.viewFor(f.task.id)).toBeUndefined();
        expect(refusal(() => f.decide('req-1')).details).toMatchObject({
            coverageReason: 'path_unproven',
        });

        release();
        await vi.advanceTimersByTimeAsync(0);

        expect(f.approvals.viewFor(f.task.id)).toMatchObject({ paths: ['/workspace/a.ts'] });
        expect(f.decide('req-1')).toEqual({ outcome: 'approved' });
        expect(f.provider.raised).toEqual([]);
    });

    it('escalates when the path check fails', async () => {
        const f = await approvalFixture(
            {},
            { pathResolver: () => Promise.reject(new CaxriError('PATH_DENIED', 'outside')) },
        );

        expect(f.ask(fileChange(['/elsewhere/a.ts']))).toBe('quiet');
        await vi.advanceTimersByTimeAsync(0);

        expect(f.provider.raised).toHaveLength(1);
        expect(refusal(() => f.decide('req-1')).details).toMatchObject({
            coverageReason: 'path_outside',
        });
    });

    it('is not covered without paths', async () => {
        const f = await approvalFixture();

        expect(f.ask({ id: 'req-1', kind: 'fileChange' })).toBe('alert');
        expect(refusal(() => f.decide('req-1')).details).toMatchObject({
            coverageReason: 'path_missing',
        });
    });

    it('is dropped without an alert when the user answers during the path check', async () => {
        const { promise: gate, resolve: release } = Promise.withResolvers<void>();
        const f = await approvalFixture(
            {},
            { pathResolver: async () => (await gate, { root: '/workspace', workspacePath: '/x' }) },
        );
        f.ask(fileChange(['/workspace/a.ts']));

        f.resolve('req-1');
        release();
        await vi.advanceTimersByTimeAsync(0);

        expect(f.provider.raised).toEqual([]);
        expect(f.provider.changes.map((change) => change.state)).toEqual(['pending', 'cancelled']);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('stops at takeover or shutdown during the path check without a second alert or a leftover timer', async () => {
        const { promise: gate, resolve: release } = Promise.withResolvers<void>();
        const f = await approvalFixture(
            {},
            { pathResolver: async () => (await gate, { root: '/workspace', workspacePath: '/x' }) },
        );
        f.ask(fileChange(['/workspace/a.ts']));

        f.service.interruptTerminal(f.child, true);
        expect(f.provider.raised).toHaveLength(1);
        release();
        await vi.advanceTimersByTimeAsync(0);
        expect(f.provider.raised).toHaveLength(1);

        const g = await approvalFixture(
            {},
            { pathResolver: async () => (await gate, { root: '/workspace', workspacePath: '/x' }) },
        );
        g.ask(fileChange(['/workspace/a.ts']));
        g.service.close();
        await vi.advanceTimersByTimeAsync(0);
        expect(g.provider.raised).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('who ends a request', () => {
    it('lets the user win: a refused answer is a conflict and the request is dropped quietly', async () => {
        const f = await approvalFixture();
        f.ask(command());
        f.provider.respondError = conflictError();

        expect(refusal(() => f.decide('req-1')).code).toBe('CONFLICT');
        expect(f.provider.raised).toEqual([]);
        expect(f.approvals.viewFor(f.task.id)).toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('drops an answered request with no alert and no early unblock', async () => {
        const f = await approvalFixture();
        f.ask(command('req-1'));
        f.ask(command('req-2'));

        f.resolve('req-1');

        expect(f.provider.raised).toEqual([]);
        expect(f.database.agentDelegations.get(f.task.id)!.receipt.status).toBe('blocked');
        expect(f.approvals.viewFor(f.task.id)).toMatchObject({ requestId: 'req-2' });
    });

    it('hands every request to the user when a person types in the delegated Chat', async () => {
        const f = await approvalFixture();
        f.ask(command());

        f.service.interruptTerminal(f.child, true);

        expect(f.provider.raised).toHaveLength(1);
        expect(f.approvals.viewFor(f.task.id)).toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps holding a request when a person types in the root delegating Agent', async () => {
        const f = await approvalFixture();
        f.ask(command());

        f.service.interruptTerminal(f.parent, true);

        expect(f.provider.raised).toHaveLength(0);
        expect(f.approvals.isHeld(f.child, 'req-1')).toBe(true);
    });

    it('stops reporting a request as held once it escalates', async () => {
        const f = await approvalFixture();
        f.ask(command());
        expect(f.approvals.isHeld(f.child, 'req-1')).toBe(true);

        f.service.interruptTerminal(f.parent, false, 'parent-launch');

        expect(f.approvals.isHeld(f.child, 'req-1')).toBe(false);
        expect(f.approvals.isHeld(f.child, 'unknown')).toBe(false);
    });

    it('hands a request to the user when the delegating Agent retires', async () => {
        const f = await approvalFixture();
        f.ask(command());

        f.service.interruptTerminal(f.parent, false, 'parent-launch');

        expect(f.provider.raised).toHaveLength(1);
        expect(f.logged(logEventCatalog.agentDelegation.approvalEscalated)).toMatchObject([
            { escalationReason: 'parent_gone' },
        ]);
    });

    it('hands a request to the user when the setting is turned off', async () => {
        const f = await approvalFixture();
        f.ask(command());

        f.provider.enabled = false;
        for (const listener of f.settingsListeners) listener();

        expect(f.provider.raised).toHaveLength(1);
        expect(refusal(() => f.decide('req-1')).details).toMatchObject({
            coverageReason: 'disabled',
        });
    });

    it('ends its requests when the task is stopped', async () => {
        const f = await approvalFixture();
        f.ask(command());

        f.approvals.taskEnded(f.task.id);

        expect(f.provider.changes.at(-1)).toMatchObject({ state: 'cancelled' });
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('who may decide', () => {
    const others: Array<[string, DelegationAuthority]> = [
        ['the owner', { principal: { kind: 'human-cli', id: 'owner' } }],
        [
            'another Agent',
            {
                principal: {
                    kind: 'agent',
                    id: 'other',
                    endpointId: 'other',
                    generation: 1,
                    projectIds: [],
                },
                callerTerminalId: 'other-terminal',
            },
        ],
        [
            'a delegation client',
            {
                principal: {
                    kind: 'delegation-client',
                    id: 'client',
                    clientId: 'client',
                    generation: 1,
                    projectIds: ['project'],
                    sessionId: 'session',
                    callerProvider: 'codex',
                },
            },
        ],
    ];

    it.each(others)(
        'refuses %s with the same fixed answer as a missing request',
        async (_name, authority) => {
            const f = await approvalFixture();
            f.ask(command());

            const error = refusal(() => f.decide('req-1', 'accept', authority));
            const missing = refusal(() => f.decide('nope'));

            expect(error).toMatchObject({ code: 'NOT_FOUND', message: missing.message });
            expect(f.provider.responses).toEqual([]);
        },
    );

    it('answers the same for the delegated child itself', async () => {
        const f = await approvalFixture();
        f.ask(command());

        const error = refusal(() =>
            f.decide('req-1', 'accept', {
                principal: { ...f.authority.principal },
                callerTerminalId: f.child,
            }),
        );

        expect(error.code).toBe('NOT_FOUND');
    });
});

describe('what the delegating Agent and the user see', () => {
    it('reports whom the task waits on, with a question beside an approval', async () => {
        const f = await approvalFixture();
        f.ask(command('req-1'));
        expect(f.approvals.feed([f.task.id]).get(f.task.id)).toMatchObject({
            waitingOn: 'parent',
            approval: { covered: true, escalated: false },
        });

        f.ask({ id: 'q1', kind: 'question', questions: [] });

        expect(f.approvals.feed([f.task.id]).get(f.task.id)?.waitingOn).toBe('user');
    });

    it('never puts request content in a log, an event, the feed, or a raised signal', async () => {
        const f = await approvalFixture();
        f.ask(command('req-1', { reason: 'SECRET_REASON' }));
        f.ask(fileChange([SECRET_PATH], 'req-2'));
        await vi.advanceTimersByTimeAsync(0);
        f.elapse(GRACE);
        f.provider.respondError = undefined;
        f.decide('req-1', 'decline');

        const feed = JSON.stringify([...f.approvals.feed([f.task.id])]);
        const sessions = JSON.stringify(await f.sessions([f.callerSessionId]));
        for (const text of [f.observed(), feed, sessions]) expect(text).not.toMatch(/SECRET_/u);
        expect(f.provider.raised.length).toBeGreaterThan(0);
    });
});

describe('wait', () => {
    it('reports a decidable request as the approval outcome, and blocked once it is the user', async () => {
        const f = await approvalFixture();
        f.ask(command());

        const first = await f.service.wait([f.task.id], f.authority, 1000);
        expect(first.outcome).toBe('approval');
        expect(first.approval).toMatchObject({ requestId: 'req-1', command: SECRET_COMMAND });

        f.elapse(GRACE);
        const second = await f.service.wait([f.task.id], f.authority, 1000);
        expect(second.outcome).toBe('blocked');
        expect(second.approval).toMatchObject({ escalated: true });
    });

    it('reports blocked, never approval, for a request the delegating Agent cannot decide', async () => {
        const f = await approvalFixture();
        f.provider.permission.permissionMode = 'acceptEdits';
        f.ask(command());

        const result = await f.service.wait([f.task.id], f.authority, 1000);

        expect(result.outcome).toBe('blocked');
    });

    it('reports status with the approval for the delegating Agent', async () => {
        const f = await approvalFixture();
        f.ask(command());

        const status = f.service.status(f.task.id, f.authority);

        expect(status.approval).toMatchObject({ requestId: 'req-1' });
    });
});
