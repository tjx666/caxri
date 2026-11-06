import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { reasonOf } from '../retry/__tests__/fixture';
import { takenOverSession } from './hand-back.fixture';

/**
 * The closed reason a synchronous call was refused with, or `undefined` when it succeeded.
 */
function refusalOf(call: () => unknown): string | undefined {
    try {
        call();
    } catch (error) {
        return (error as { details?: { reason?: string } }).details?.reason;
    }
    return undefined;
}
describe('hand-back grant', () => {
    it('grants the delegating Agent one follow-up of the newest task and marks the Session pending', async () => {
        const f = await takenOverSession();
        const reply = f.service.handBacks.handBack(f.id);
        expect(reply).toMatchObject({ delegationId: f.id, status: 'granted' });
        expect(f.grants()).toMatchObject([
            {
                id: reply.grantId,
                state: 'pending',
                delegationId: f.id,
                launchId: 'child-launch',
                turnId: 'turn-1',
                callerTerminalId: f.callerTerminalId,
                callerLaunchId: 'caller-launch',
            },
        ]);
        const feed = f.service.sessions([f.database.getSession(f.sessionId)!.createdBySessionId!]);
        expect(feed.find((entry) => entry.sessionId === f.sessionId)?.control).toBe(
            'handback_pending',
        );
    });

    it('names the newest task that ran when an older task of the Session is named, and returns it to the user again', async () => {
        const f = await takenOverSession();
        f.service.handBacks.handBack(f.id);
        const followUpId = randomUUID();
        await f.followUp(followUpId);
        const sent = f.stored(followUpId);
        f.database.agentDelegations.save({
            ...sent,
            turnId: 'turn-2',
            receipt: { ...sent.receipt, status: 'completed' },
        });
        f.service.observe(f.signal('turnFinished', 'turn-2'));
        f.service.interruptTerminal(f.terminal.id, true);
        const callerSession = f.database.getSession(f.sessionId)!.createdBySessionId!;
        const control = () =>
            f.service.sessions([callerSession]).find((entry) => entry.sessionId === f.sessionId)
                ?.control;
        expect(control()).toBe('human');
        expect(f.service.handBacks.handBack(f.id)).toMatchObject({
            delegationId: followUpId,
            status: 'granted',
        });
        expect(control()).toBe('handback_pending');
    });

    it('answers a repeated request with the grant that already exists', async () => {
        const f = await takenOverSession();
        const first = f.service.handBacks.handBack(f.id);
        expect(f.service.handBacks.handBack(f.id)).toEqual({ ...first, status: 'duplicate' });
        expect(f.grants()).toHaveLength(1);
    });

    it('reports a Session the user took over as theirs in the feed', async () => {
        const f = await takenOverSession();
        const callerSession = f.database.getSession(f.sessionId)!.createdBySessionId!;
        expect(
            f.service.sessions([callerSession]).find((entry) => entry.sessionId === f.sessionId)
                ?.control,
        ).toBe('human');
    });

    it('refuses a Session the user has not taken over', async () => {
        const f = await takenOverSession();
        f.database.agentDelegations.save({ ...f.stored(f.id), hasHumanIntervention: undefined });
        expect(refusalOf(() => f.service.handBacks.handBack(f.id))).toBe('not_taken_over');
    });

    it('refuses an unknown task', async () => {
        const f = await takenOverSession();
        expect(() => f.service.handBacks.handBack(randomUUID())).toThrow('unavailable');
    });

    it.each([
        [
            'the child is still in a turn',
            'child_busy',
            (f: Awaited<ReturnType<typeof takenOverSession>>) => {
                f.idle.value = false;
            },
        ],
        [
            'the child launch was replaced',
            'child_changed',
            (f: Awaited<ReturnType<typeof takenOverSession>>) => {
                f.state.childLaunch = 'other-launch';
            },
        ],
        [
            'the delegating Agent is gone',
            'parent_gone',
            (f: Awaited<ReturnType<typeof takenOverSession>>) => {
                f.state.callerLaunch = undefined;
            },
        ],
        [
            'the delegating Agent restarted',
            'parent_changed',
            (f: Awaited<ReturnType<typeof takenOverSession>>) => {
                f.state.callerLaunch = 'new-caller-launch';
            },
        ],
    ])('refuses when %s', async (_name, reason, change) => {
        const f = await takenOverSession();
        change(f);
        expect(refusalOf(() => f.service.handBacks.handBack(f.id))).toBe(reason);
        expect(f.grants()).toHaveLength(0);
    });

    it('refuses when the delegating Agent is another Endpoint generation', async () => {
        const f = await takenOverSession();
        f.state.generation = 2;
        expect(refusalOf(() => f.service.handBacks.handBack(f.id))).toBe('parent_changed');
    });

    it('wakes the delegating Agent once with the hand-back line and nothing about the Session content', async () => {
        const f = await takenOverSession();
        const { grantId } = f.service.handBacks.handBack(f.id);
        await vi.waitFor(() => expect(f.deliveries).toHaveLength(1));
        expect(f.deliveries[0]).toBe(
            `[Caxri] The user handed Session ${f.sessionId} back to you (task ${f.id}). Continue with: caxri agent delegate create --follow-up ${f.id} ...`,
        );
        expect(f.noticeFor(grantId)?.state).toBe('delivered');
    });

    it('does not announce a grant that was dropped before the notice was sent', async () => {
        const f = await takenOverSession();
        const { grantId } = f.service.handBacks.handBack(f.id);
        f.service.interruptTerminal(f.terminal.id, true);
        await vi.waitFor(() => expect(f.noticeFor(grantId)?.state).toBe('skipped'));
        expect(f.deliveries).toHaveLength(0);
    });
});

describe('hand-back use', () => {
    it('lets the follow-up through once on the pinned launch and returns the Session to the Agent', async () => {
        const f = await takenOverSession();
        const { grantId } = f.service.handBacks.handBack(f.id);
        const followUpId = randomUUID();
        const receipt = await f.followUp(followUpId);
        expect(receipt).toMatchObject({ status: 'submitting', terminalId: f.terminal.id });
        expect(f.write).toHaveBeenCalledTimes(1);
        expect(f.grants()).toMatchObject([
            { id: grantId, state: 'consumed', consumedBy: followUpId },
        ]);
        expect(f.stored(followUpId)).toMatchObject({ launchId: 'child-launch' });
        expect(f.stored(f.id).nextDelegationId).toBe(followUpId);
        const callerSession = f.database.getSession(f.sessionId)!.createdBySessionId!;
        expect(
            f.service.sessions([callerSession]).find((entry) => entry.sessionId === f.sessionId)
                ?.control,
        ).toBe('delegated');
    });

    it('does not let a second follow-up through on the same grant', async () => {
        const f = await takenOverSession();
        f.service.handBacks.handBack(f.id);
        await f.followUp();
        const second = await f.followUp();
        expect(second).toMatchObject({ status: 'failed' });
        expect(f.write).toHaveBeenCalledTimes(1);
    });

    it('still refuses a follow-up of a taken-over task that was never handed back', async () => {
        const f = await takenOverSession();
        expect(await f.followUp()).toMatchObject({ status: 'failed' });
        expect(f.write).not.toHaveBeenCalled();
    });

    it('drops the grant when the user types in the child Terminal afterwards', async () => {
        const f = await takenOverSession();
        f.service.handBacks.handBack(f.id);
        f.service.interruptTerminal(f.terminal.id, true);
        expect(f.grants()).toMatchObject([{ state: 'invalidated' }]);
        expect(await f.followUp()).toMatchObject({ status: 'failed' });
        expect(f.write).not.toHaveBeenCalled();
    });

    it('drops the grant when the child starts a turn of its own', async () => {
        const f = await takenOverSession();
        f.service.handBacks.handBack(f.id);
        f.service.observe(f.signal('turnStarted', 'turn-2'));
        expect(f.grants()).toMatchObject([{ state: 'invalidated' }]);
    });

    it('drops the grant when the input epoch moved without a signal', async () => {
        const f = await takenOverSession();
        f.service.handBacks.handBack(f.id);
        f.state.epoch += 1;
        expect(await f.followUp()).toMatchObject({ status: 'failed' });
        expect(f.grants()).toMatchObject([{ state: 'invalidated' }]);
    });

    it('drops the grant when the delegating Agent was replaced before it used it', async () => {
        const f = await takenOverSession();
        f.service.handBacks.handBack(f.id);
        f.state.callerLaunch = 'new-caller-launch';
        expect(await f.followUp()).toMatchObject({ status: 'failed' });
        expect(f.grants()).toMatchObject([{ state: 'invalidated' }]);
    });

    it('keeps the grant when another task holds the Terminal for a moment', async () => {
        const f = await takenOverSession();
        f.service.handBacks.handBack(f.id);
        // Not the grant's fault: a different task on the Terminal is the transient clash, not a moved pin.
        const other = f.stored(f.id);
        f.database.agentDelegations.save({ ...other, nextDelegationId: 'someone-else' });
        expect(await f.followUp()).toMatchObject({ status: 'failed' });
        expect(f.grants()).toMatchObject([{ state: 'pending' }]);
    });

    it('drops every pending grant on Server restart', async () => {
        const f = await takenOverSession();
        f.service.handBacks.handBack(f.id);
        f.service.initialize();
        expect(f.grants()).toMatchObject([{ state: 'invalidated' }]);
    });

    it('gives the grant back when the Host refuses the write before anything was sent', async () => {
        const f = await takenOverSession();
        f.service.handBacks.handBack(f.id);
        f.write.mockReturnValueOnce(false);
        expect(await f.followUp()).toMatchObject({ status: 'failed' });
        expect(f.grants()).toMatchObject([{ state: 'pending' }]);
        expect(f.stored(f.id).nextDelegationId).toBeUndefined();
        expect(await f.followUp()).toMatchObject({ status: 'submitting' });
        expect(f.grants()).toMatchObject([{ state: 'consumed' }]);
    });
});

describe('fresh create into a taken-over Session', () => {
    const fresh = (f: Awaited<ReturnType<typeof takenOverSession>>) =>
        f.service.create(randomUUID(), f.authority, {
            projectId: f.project.id,
            sessionId: f.sessionId,
            provider: 'claude',
            prompt: 'Synthetic fresh task',
        });

    it('is refused for an Agent while the Session is the user’s', async () => {
        const f = await takenOverSession();
        expect(await reasonOf(fresh(f))).toBe('session_taken_over');
        expect(f.start).toHaveBeenCalledTimes(1);
    });

    it('is not blocked by the check once the Session was handed back and used', async () => {
        const f = await takenOverSession();
        f.service.handBacks.handBack(f.id);
        await f.followUp();
        expect(await reasonOf(fresh(f))).not.toBe('session_taken_over');
    });
});

describe('hand-back review gaps', () => {
    it('refuses a Terminal child whose prompt holds text the user typed and did not submit', async () => {
        const f = await takenOverSession();
        f.service.observe(f.signal('turnStarted'));
        f.service.observe(f.signal('turnFinished'));
        f.state.epoch += 3;
        f.service.notices.observeInput(f.terminal.id, 'abc');

        expect(refusalOf(() => f.service.handBacks.handBack(f.id))).toBe('draft_active');
        expect(f.grants()).toHaveLength(0);
    });

    it('grants a Terminal child whose prompt is empty after its turn', async () => {
        const f = await takenOverSession();
        f.service.observe(f.signal('turnStarted'));
        f.service.observe(f.signal('turnFinished'));

        expect(f.service.handBacks.handBack(f.id)).toMatchObject({ status: 'granted' });
    });

    it('refuses a fresh create from an outside client and from any Agent while the grant is pending', async () => {
        const f = await takenOverSession();
        const client = { principal: { kind: 'delegation-client', id: 'external-one-1' } } as never;
        expect(
            refusalOf(() => f.service.handBacks.assertFreshCreateAllowed(client, f.sessionId)),
        ).toBe('session_taken_over');

        f.service.handBacks.handBack(f.id);
        const fresh = f.service.create(randomUUID(), f.authority, {
            projectId: f.project.id,
            sessionId: f.sessionId,
            provider: 'claude',
            prompt: 'Synthetic fresh task',
        });

        expect(await reasonOf(fresh)).toBe('session_taken_over');
        expect(
            refusalOf(() => f.service.handBacks.assertFreshCreateAllowed(client, f.sessionId)),
        ).toBe('session_taken_over');
    });

    it('does not wake the caller about a follow-up that its own create refused', async () => {
        const f = await takenOverSession();
        const refusedId = randomUUID();

        expect(await f.followUp(refusedId)).toMatchObject({ status: 'failed' });
        await new Promise((resolve) => setTimeout(resolve, 60));

        expect(f.deliveries).toHaveLength(0);
        expect(f.database.agentDelegations.notices.get(`settled:${refusedId}`)).toMatchObject({
            state: 'skipped',
        });
    });

    it('does not wake the caller about a task it stopped itself', async () => {
        const f = await takenOverSession();
        f.service.handBacks.handBack(f.id);
        await vi.waitFor(() => expect(f.deliveries).toHaveLength(1));
        const followUpId = randomUUID();
        await f.followUp(followUpId);

        expect(f.service.stop(followUpId, f.authority)).toMatchObject({ status: 'interrupted' });
        await new Promise((resolve) => setTimeout(resolve, 60));

        expect(f.deliveries).toHaveLength(1);
        expect(f.database.agentDelegations.notices.get(`settled:${followUpId}`)).toMatchObject({
            state: 'skipped',
        });
    });
});

describe('automatic hand-back', () => {
    it('grants through the same guards as the owner', async () => {
        const f = await takenOverSession();
        expect(f.service.handBacks.autoHandBack(f.sessionId)).toBe('granted');
        expect(f.grants()).toMatchObject([{ state: 'pending', delegationId: f.id }]);
        expect(f.service.handBacks.autoHandBack(f.sessionId)).toBe('duplicate');
    });

    it('tells the delegating Agent that Caxri, not the user, handed the Session back', async () => {
        const f = await takenOverSession();
        expect(f.service.handBacks.autoHandBack(f.sessionId)).toBe('granted');
        await vi.waitFor(() => expect(f.deliveries).toHaveLength(1));
        expect(f.deliveries[0]).toBe(
            `[Caxri] Caxri handed Session ${f.sessionId} back to you automatically after the user left it alone (task ${f.id}); the user did not hand it back. Continue with: caxri agent delegate create --follow-up ${f.id} ...`,
        );
    });

    it('lists each takeover and hand-back in the feed, and drops a hand-back the user took back', async () => {
        const f = await takenOverSession();
        const callerSession = f.database.getSession(f.sessionId)!.createdBySessionId!;
        const changes = () =>
            f.service.sessions([callerSession]).find((entry) => entry.sessionId === f.sessionId)
                ?.controlChanges;
        const takenOverAt = f.stored(f.id).humanInterventionAt!;
        expect(changes()).toEqual([{ kind: 'taken_over', at: takenOverAt }]);
        f.service.handBacks.autoHandBack(f.sessionId);
        const [grant] = f.grants();
        expect(changes()).toEqual([
            { kind: 'taken_over', at: takenOverAt },
            { kind: 'handed_back', at: grant.createdAt, trigger: 'auto' },
        ]);
        f.service.interruptTerminal(f.terminal.id, true);
        expect(changes()).toEqual([{ kind: 'taken_over', at: takenOverAt }]);
    });

    it('answers a refusal instead of throwing, and stores no grant', async () => {
        const f = await takenOverSession();
        f.idle.value = false;
        expect(f.service.handBacks.autoHandBack(f.sessionId)).toBe('child_busy');
        f.idle.value = true;
        f.state.callerLaunch = undefined;
        expect(f.service.handBacks.autoHandBack(f.sessionId)).toBe('parent_gone');
        expect(f.grants()).toHaveLength(0);
    });
});
