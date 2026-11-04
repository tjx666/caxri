import type { AgentChatRequest, AgentProvider } from '@caxri/protocol';
import { APPROVAL_ESCALATION_GRACE_MS, CaxriError } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentAdapter } from '../../../agents';
import { AgentCoordinator, AgentService } from '../../../agents';
import type { FileChange } from './approvals.fixture';
import { approvalFixture, command } from './approvals.fixture';

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
const question = (id = 'q-1'): AgentChatRequest => ({ id, kind: 'question', questions: [] });

const refusal = (run: () => unknown) => {
    try {
        run();
    } catch (error) {
        return error as CaxriError;
    }
    throw new Error('expected a refusal');
};

/**
 * The delegation approvals facade composed with a real `AgentCoordinator` over the fixture's real database, so the
 * delegated Session's activity state, unread mark, and attention generation are the ones a user would see. It wires the
 * two Server Core entry points the way `observeChatLifecycleSignal` and `raiseChatAttention` do: the facade classifies
 * a signal synchronously, the coordinator applies it (quiet when held), and the delegation service observes it
 * afterwards.
 */
async function coordinatedFixture(pathResolver?: Parameters<typeof approvalFixture>[1]) {
    const f = await approvalFixture({}, pathResolver);
    const renameSession: AgentAdapter['renameSession'] = () => new Promise<never>(() => {});
    const snapshot: AgentAdapter['snapshot'] = () => Promise.reject(new Error('not used'));
    const adapters = Object.fromEntries(
        (['claude', 'codex', 'grok', 'antigravity'] as AgentProvider[]).map((provider) => [
            provider,
            { provider, renameSession, snapshot },
        ]),
    ) as Record<AgentProvider, AgentAdapter>;
    const logger = new StructuredLogger(`${f.directory}/logs`);
    const coordinator = new AgentCoordinator(
        f.database,
        new AgentService(undefined, adapters),
        () => {},
        logger,
    );
    coordinator.beginTerminalLaunch(f.child, f.base.launchId);
    coordinator.observeLifecycleSignal({ ...f.base, phase: 'turnStarted' });
    f.environment.raiseAttention = (signal) => coordinator.raiseHeldAttention(signal);
    const session = () => f.database.getSession(f.task.receipt.sessionId)!;

    const ask = (request: AgentChatRequest) => {
        f.provider.requests = [
            ...f.provider.requests.filter((other) => other.id !== request.id),
            request,
        ];
        const signal = {
            ...f.base,
            phase: 'attentionRequested' as const,
            agentToolUseId: request.id,
        };
        const alert = f.approvals.classify(signal);
        coordinator.observeLifecycleSignal(alert === 'quiet' ? { ...signal, alert } : signal);
        f.service.observe(signal);
        return alert;
    };
    const answer = (requestId: string) => {
        f.provider.requests = f.provider.requests.filter((request) => request.id !== requestId);
        f.approvals.observe(f.child);
        const signal = {
            ...f.base,
            phase: 'attentionResolved' as const,
            agentToolUseId: requestId,
        };
        coordinator.observeLifecycleSignal(signal);
        f.service.observe(signal);
    };
    const receipt = () => f.database.agentDelegations.get(f.task.id)!.receipt;
    return { ...f, answer, ask, coordinator, receipt, session };
}

describe('a held request on a real Session', () => {
    it('keeps the Session running and read during the grace, then alerts exactly once', async () => {
        const f = await coordinatedFixture();
        const generation = f.session().attentionGeneration;

        expect(f.ask(command())).toBe('quiet');
        f.elapse(GRACE - 1);
        expect(f.session()).toMatchObject({ agentActivityState: 'running', hasUnread: false });
        expect(f.session().attentionGeneration).toBe(generation);

        f.elapse(1);
        expect(f.session()).toMatchObject({
            agentActivityState: 'waiting',
            hasUnread: true,
            lastAttentionKind: 'waiting',
        });
        expect(f.session().attentionGeneration).toBe(generation + 1);

        f.elapse(GRACE * 3);
        expect(f.session().attentionGeneration).toBe(generation + 1);
        await f.coordinator.close();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('alerts on takeover of the delegated Chat and never twice', async () => {
        const f = await coordinatedFixture();
        const generation = f.session().attentionGeneration;
        f.ask(command());

        f.service.interruptTerminal(f.child, true);

        expect(f.session()).toMatchObject({ agentActivityState: 'waiting', hasUnread: true });
        expect(f.session().attentionGeneration).toBe(generation + 1);
        await f.coordinator.close();
    });
});

describe('the user answers while the path check runs', () => {
    const gated = () => {
        const { promise: gate, resolve: release } = Promise.withResolvers<{
            root: string;
            workspacePath: string;
        }>();
        return { release, resolver: () => gate };
    };

    it('leaves no waiting state and no stale alert when the check finds the path inside', async () => {
        const { release, resolver } = gated();
        const f = await coordinatedFixture({ pathResolver: resolver });
        const generation = f.session().attentionGeneration;
        expect(f.ask(fileChange(['/workspace/a.ts']))).toBe('quiet');

        f.answer('req-1');
        release({ root: '/workspace', workspacePath: '/workspace/a.ts' });
        await vi.advanceTimersByTimeAsync(0);

        expect(f.session()).toMatchObject({ agentActivityState: 'running', hasUnread: false });
        expect(f.session().attentionGeneration).toBe(generation);
        expect(f.provider.raised).toEqual([]);
        await f.coordinator.close();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('leaves no waiting state and no stale alert when the check would have found it outside', async () => {
        const { release, resolver } = gated();
        const f = await coordinatedFixture({ pathResolver: resolver });
        const generation = f.session().attentionGeneration;
        f.ask(fileChange(['/elsewhere/a.ts']));

        f.answer('req-1');
        release({ root: '/workspace', workspacePath: '/elsewhere/a.ts' });
        await vi.advanceTimersByTimeAsync(0);

        expect(f.session()).toMatchObject({ agentActivityState: 'running', hasUnread: false });
        expect(f.session().attentionGeneration).toBe(generation);
        expect(f.provider.raised).toEqual([]);
        expect(f.approvals.viewFor(f.task.id)).toBeUndefined();
        await f.coordinator.close();
    });

    it('stays quiet when the server closes during the check', async () => {
        const { release, resolver } = gated();
        const f = await coordinatedFixture({ pathResolver: resolver });
        const generation = f.session().attentionGeneration;
        f.ask(fileChange(['/elsewhere/a.ts']));

        f.service.close();
        release({ root: '/workspace', workspacePath: '/elsewhere/a.ts' });
        await vi.advanceTimersByTimeAsync(0);

        expect(f.session().attentionGeneration).toBe(generation);
        expect(f.provider.raised).toEqual([]);
        await f.coordinator.close();
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('two concurrent approvals', () => {
    it('lets one decision win and the other find the request already resolved', async () => {
        const f = await coordinatedFixture();
        const generation = f.session().attentionGeneration;
        f.ask(command('req-1'));

        const results = await Promise.allSettled([
            Promise.try(() => f.decide('req-1', 'accept')),
            Promise.try(() => f.decide('req-1', 'decline')),
        ]);

        expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
        expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(CaxriError);
        expect(f.provider.responses).toEqual([{ requestId: 'req-1', decision: 'accept' }]);
        expect(f.session().attentionGeneration).toBe(generation);
        expect(f.session().agentActivityState).toBe('running');
        await f.coordinator.close();
    });

    it('keeps the task blocked until the last of two requests is resolved, with no alert', async () => {
        const f = await coordinatedFixture();
        const generation = f.session().attentionGeneration;
        f.ask(command('req-1'));
        f.ask(command('req-2'));

        f.decide('req-1');
        f.answer('req-1');
        expect(f.receipt().status).toBe('blocked');
        expect(f.approvals.viewFor(f.task.id)).toMatchObject({ requestId: 'req-2' });

        f.decide('req-2');
        f.answer('req-2');

        expect(f.receipt().status).toBe('running');
        expect(f.session()).toMatchObject({ agentActivityState: 'running', hasUnread: false });
        expect(f.session().attentionGeneration).toBe(generation);
        await f.coordinator.close();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('hands one to the user while the other is still decided by the delegating Agent', async () => {
        const f = await coordinatedFixture();
        const generation = f.session().attentionGeneration;
        f.ask(command('req-1'));
        f.elapse(GRACE - 10);
        f.ask(command('req-2'));

        f.elapse(10);

        expect(f.session().attentionGeneration).toBe(generation + 1);
        expect(f.decide('req-1')).toEqual({ outcome: 'approved' });
        expect(f.decide('req-2')).toEqual({ outcome: 'approved' });
        await f.coordinator.close();
    });
});

describe('a question and an approval pending together', () => {
    it('keeps the task blocked and waiting on the user until both are answered', async () => {
        const f = await coordinatedFixture();
        f.ask(command('req-1'));
        f.ask(question());

        // The question takes the ordinary alert; the held approval does not add one.
        expect(f.session()).toMatchObject({ agentActivityState: 'waiting', hasUnread: true });
        expect(f.approvals.feed([f.task.id]).get(f.task.id)?.waitingOn).toBe('user');

        f.answer('q-1');
        expect(f.receipt().status).toBe('blocked');
        expect(f.approvals.feed([f.task.id]).get(f.task.id)?.waitingOn).toBe('parent');

        f.decide('req-1');
        f.answer('req-1');
        expect(f.receipt().status).toBe('running');
        expect(f.session().agentActivityState).toBe('running');
        await f.coordinator.close();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not unblock the task when the approval is answered first', async () => {
        const f = await coordinatedFixture();
        f.ask(command('req-1'));
        f.ask(question());

        f.decide('req-1');
        f.answer('req-1');

        expect(f.receipt().status).toBe('blocked');
        expect(f.session()).toMatchObject({ agentActivityState: 'waiting', hasUnread: true });
        await f.coordinator.close();
    });
});

describe('shutdown during the grace', () => {
    it('leaves no timer and never alerts afterwards', async () => {
        const f = await coordinatedFixture();
        const generation = f.session().attentionGeneration;
        f.ask(command('req-1'));
        f.ask(command('req-2'));
        expect(vi.getTimerCount()).toBeGreaterThanOrEqual(2);

        f.service.close();

        await f.coordinator.close();
        expect(vi.getTimerCount()).toBe(0);
        f.elapse(GRACE * 2);
        expect(f.provider.raised).toEqual([]);
        expect(f.session().attentionGeneration).toBe(generation);
        expect(refusal(() => f.decide('req-1')).code).toBeDefined();
        await f.coordinator.close();
    });
});
