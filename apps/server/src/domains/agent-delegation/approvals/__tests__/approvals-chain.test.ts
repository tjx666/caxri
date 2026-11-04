import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { CaxriError } from '@caxri/protocol';
import { logEventCatalog } from '@caxri/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { approvalFixture, command } from './approvals.fixture';

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

const refusal = (run: () => unknown) => {
    try {
        run();
    } catch (error) {
        return error as CaxriError;
    }
    throw new Error('expected a refusal');
};

const chain = () => approvalFixture({}, { chain: true });
type Chain = Awaited<ReturnType<typeof chain>>;

/**
 * Root A delegated B, and B delegated the Chat C whose requests these tests drive; B is `f.parent`, A is `f.root`.
 */
describe('a request two Agents below the root', () => {
    it('is held and decided by the Agent that delegated it while both Agents cover it', async () => {
        const f = await chain();

        expect(f.ask(command())).toBe('quiet');
        expect(f.decide('req-1')).toEqual({ outcome: 'approved' });

        expect(f.provider.responses).toEqual([{ requestId: 'req-1', decision: 'accept' }]);
        expect(f.provider.raised).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('is not covered when the root Agent does not cover it', async () => {
        const f = await chain();
        f.provider.permissions.get(f.root)!.permissionMode = 'acceptEdits';

        expect(f.ask(command())).toBe('alert');
        expect(f.provider.raised).toEqual([]);
        expect(f.logged(logEventCatalog.agentDelegation.approvalRequested)).toMatchObject([
            { coverageReason: 'ancestor_not_covering' },
        ]);
    });

    describe('when a person takes over the middle Agent', () => {
        const takeOver = (f: Chain) => f.service.interruptTerminal(f.parent, true);

        it('hands a pending request to the user at once and refuses the middle Agent afterwards', async () => {
            const f = await chain();
            f.ask(command());

            takeOver(f);

            expect(f.provider.raised).toHaveLength(1);
            expect(f.logged(logEventCatalog.agentDelegation.approvalEscalated)).toMatchObject([
                { escalationReason: 'ancestor_taken_over' },
            ]);
            expect(f.approvals.viewFor(f.task.id)).toMatchObject({ escalated: true });
            // The delegated Chat C itself was never touched; only B's own task was.
            expect(f.database.agentDelegations.get(f.task.id)!.hasHumanIntervention).toBeFalsy();

            const error = refusal(() => f.decide('req-1'));
            expect(error.code).toBe('FORBIDDEN');
            expect(error.details).toMatchObject({ coverageReason: 'ancestor_taken_over' });
            expect(f.provider.responses).toEqual([]);
            expect(f.provider.raised).toHaveLength(1);
            expect(vi.getTimerCount()).toBe(0);
        });

        it('never covers a request asked after the takeover', async () => {
            const f = await chain();
            takeOver(f);

            expect(f.ask(command())).toBe('alert');

            expect(f.logged(logEventCatalog.agentDelegation.approvalRequested)).toMatchObject([
                { coverageReason: 'ancestor_taken_over' },
            ]);
            expect(refusal(() => f.decide('req-1')).details).toMatchObject({
                coverageReason: 'ancestor_taken_over',
            });
            expect(f.provider.responses).toEqual([]);
            expect(vi.getTimerCount()).toBe(0);
        });

        it('treats input to the root Agent as direction: no early escalation, still approvable', async () => {
            const f = await chain();
            f.ask(command());

            f.service.interruptTerminal(f.root, true);

            expect(f.provider.raised).toHaveLength(0);
            expect(f.approvals.isHeld(f.child, 'req-1')).toBe(true);
            expect(() => f.decide('req-1')).not.toThrow();
        });
    });

    describe('when a delegating Agent launch retires', () => {
        it.each([
            ['the middle Agent', (f: Chain) => f.parent, 'launch-1'],
            ['the root Agent', (f: Chain) => f.root, 'parent-launch'],
        ])('hands the request to the user when %s retires', async (_name, terminal, launchId) => {
            const f = await chain();
            f.ask(command());

            f.service.interruptTerminal(terminal(f), false, launchId);

            expect(f.provider.raised).toHaveLength(1);
            expect(f.logged(logEventCatalog.agentDelegation.approvalEscalated)).toMatchObject([
                { escalationReason: 'parent_gone' },
            ]);
            expect(f.provider.responses).toEqual([]);
        });

        it('refuses a request asked after the middle Agent was relaunched', async () => {
            const f = await chain();
            f.launches.set(f.parent, 'relaunched');

            expect(f.ask(command())).toBe('alert');

            expect(f.logged(logEventCatalog.agentDelegation.approvalRequested)).toMatchObject([
                { coverageReason: 'parent_launch_unknown' },
            ]);
        });
    });

    it('stops covering a request once the middle Agent task is no longer active', async () => {
        const f = await chain();
        f.ask(command());
        const middle = f.database.agentDelegations.get(
            f.database.agentDelegations.get(f.task.id)!.receipt.parentDelegationId!,
        )!;
        f.database.agentDelegations.save({
            ...middle,
            receipt: { ...middle.receipt, status: 'completed' },
        });

        const error = refusal(() => f.decide('req-1'));

        expect(error.code).toBe('FORBIDDEN');
        expect(error.details).toMatchObject({ coverageReason: 'lineage_unproven' });
        expect(f.provider.responses).toEqual([]);
        expect(f.provider.raised).toHaveLength(1);
    });

    it('refuses a request whose Session root moved between the request and the answer, and shows the user', async () => {
        const f = await chain();
        f.ask(command());
        await mkdir(join(f.directory, 'moved'));
        const moved = f.database.createProject(join(f.directory, 'moved'));
        f.database.selectWorkbenchProject(f.task.receipt.sessionId, moved.id, {
            device: '1',
            inode: '2',
        });

        expect(refusal(() => f.decide('req-1')).code).toBe('CONFLICT');

        expect(f.provider.responses).toEqual([]);
        expect(f.provider.raised).toHaveLength(1);
        expect(f.approvals.viewFor(f.task.id)).toBeUndefined();
        expect(f.provider.changes.at(-1)).toMatchObject({ state: 'cancelled' });
        expect(vi.getTimerCount()).toBe(0);
    });

    describe('input while a delegated Agent is still starting', () => {
        it('answers a startup prompt without taking the task over or disturbing the request', async () => {
            const f = await chain();
            f.ask(command());
            const starting = await f.service.create(randomUUID(), f.authority, f.request);
            const record = f.database.agentDelegations.get(starting.delegationId)!;
            f.database.agentDelegations.save({
                ...record,
                receipt: { ...record.receipt, status: 'awaiting_ready' },
            });

            f.service.interruptTerminal(starting.terminalId!, true);

            const after = f.database.agentDelegations.get(starting.delegationId)!;
            expect(after.hasHumanIntervention).toBeFalsy();
            expect(after.receipt.status).toBe('awaiting_ready');
            expect(f.provider.raised).toEqual([]);
            expect(f.decide('req-1')).toEqual({ outcome: 'approved' });
        });

        it('still counts input in the middle Agent once its task has begun', async () => {
            const f = await chain();
            f.ask(command());

            f.service.interruptTerminal(f.parent, true);

            expect(f.database.agentDelegations.forTerminal(f.parent)[0].hasHumanIntervention).toBe(
                true,
            );
            expect(f.provider.raised).toHaveLength(1);
        });
    });
});
