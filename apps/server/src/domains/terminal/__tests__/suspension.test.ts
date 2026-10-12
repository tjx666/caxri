import { describe, expect, it, vi } from 'vitest';

import { UNTOUCHED_SUSPENSION_DELAY_MS } from '../suspension-policy';
import { createHarness, idleAfterThirtyMinutes, terminal } from './suspension.fixture';

describe('TerminalSuspensionService', () => {
    it('does not suspend a starting Agent before lifecycle activation on an old Server', async () => {
        const harness = createHarness({ settings: idleAfterThirtyMinutes });
        harness.service.start();
        harness.advance(31 * 60_000);
        harness.terminals.set(
            'terminal-a',
            terminal('terminal-a', 'session-a', {
                lastAgentProcessState: 'starting',
            }),
        );
        harness.advance(15_000);
        await harness.poller()!.pollOnce();
        expect(harness.suspend).not.toHaveBeenCalled();
        await harness.service.close();
    });

    it('registers a sweep poller and treats unselected Sessions as left at startup', async () => {
        const harness = createHarness();
        harness.service.start();
        expect(harness.poller()?.label).toBe('terminal-suspension');
        // Without an observed launch the untouched rule cannot fire; the idle rule is off by default.
        harness.advance(UNTOUCHED_SUSPENSION_DELAY_MS);
        expect(await harness.service.sweep()).toEqual([]);
        harness.service.observeLaunch('terminal-a');
        harness.advance(UNTOUCHED_SUSPENSION_DELAY_MS);
        expect(await harness.service.sweep()).toEqual(['terminal-a']);
        expect(harness.events).toEqual([
            {
                event: 'state.changed',
                payload: { kind: 'records', sessionIds: [], terminalIds: ['terminal-a'] },
            },
        ]);
    });

    it('suspends a glanced-at Agent only after the user leaves its Session and never the selected one', async () => {
        const harness = createHarness({ selected: 'session-a' });
        harness.service.start();
        harness.service.observeLaunch('terminal-a');
        harness.advance(UNTOUCHED_SUSPENSION_DELAY_MS * 2);
        expect(await harness.service.sweep()).toEqual([]);
        harness.select('session-b');
        expect(await harness.service.sweep()).toEqual([]);
        harness.advance(UNTOUCHED_SUSPENSION_DELAY_MS);
        expect(await harness.service.sweep()).toEqual(['terminal-a']);
        expect(harness.suspend).toHaveBeenCalledTimes(1);
    });

    it('never suspends the Agent Commander Terminal, which the Workbench never selects', async () => {
        const harness = createHarness({ commanderSessionId: 'session-a' });
        harness.service.start();
        harness.service.observeLaunch('terminal-a');
        harness.advance(UNTOUCHED_SUSPENSION_DELAY_MS * 2);
        expect(await harness.service.sweep()).toEqual([]);
        expect(harness.suspend).not.toHaveBeenCalled();
    });

    it('keeps an Agent the user typed into or that ran a turn', async () => {
        const harness = createHarness({ selected: 'session-a' });
        harness.service.start();
        harness.service.observeLaunch('terminal-a');
        harness.service.observeInput('terminal-a', 'hello');
        harness.select('session-b');
        harness.advance(UNTOUCHED_SUSPENSION_DELAY_MS);
        expect(await harness.service.sweep()).toEqual([]);

        harness.select('session-a');
        harness.service.observeLaunch('terminal-a');
        harness.service.observeLifecycle({ phase: 'turnStarted', terminalId: 'terminal-a' });
        harness.service.observeLifecycle({ phase: 'turnFinished', terminalId: 'terminal-a' });
        harness.select('session-b');
        harness.advance(UNTOUCHED_SUSPENSION_DELAY_MS);
        expect(await harness.service.sweep()).toEqual([]);
    });

    it('detaches only the live Agent Terminals of a Session and leaves Shell tabs running', async () => {
        const harness = createHarness({ selected: 'session-a' });
        harness.terminals.set(
            'shell-a',
            terminal('shell-a', 'session-a', {
                kind: 'shell',
                lastAgentProcessState: undefined,
                provider: undefined,
            }),
        );
        harness.live.add('shell-a');
        expect(await harness.service.detachSession('session-a')).toEqual(['terminal-a']);
        expect(harness.suspend).toHaveBeenCalledWith('terminal-a', 'detached', undefined);
        expect(harness.terminals.get('terminal-a')?.lastProcessState).toBe('detached');
        expect(harness.terminals.get('shell-a')?.lastProcessState).toBe('running');
        expect(harness.events).toEqual([
            {
                event: 'state.changed',
                payload: { kind: 'records', sessionIds: [], terminalIds: ['terminal-a'] },
            },
        ]);
        // Nothing left to detach: the parked Terminal has no process, so the call is a no-op.
        expect(await harness.service.detachSession('session-a')).toEqual([]);
    });

    it('never re-parks a detached Terminal during a sweep', async () => {
        const harness = createHarness({
            selected: 'session-a',
            settings: idleAfterThirtyMinutes,
        });
        harness.service.start();
        harness.service.observeLaunch('terminal-a');
        await harness.service.detachSession('session-a');
        harness.select('session-b');
        harness.advance(60 * 60 * 1000);
        expect(await harness.service.sweep()).toEqual([]);
        expect(harness.terminals.get('terminal-a')?.lastProcessState).toBe('detached');
    });

    it('hands over an Agent launch that lands while its Session is detaching, never a Shell launch', async () => {
        const harness = createHarness({ controlledSuspend: true, selected: 'session-a' });
        const detaching = harness.service.detachSession('session-a');
        await vi.waitFor(() => expect(harness.suspend).toHaveBeenCalledTimes(1));
        const agent = terminal('agent-late', 'session-a');
        const shell = terminal('shell-late', 'session-a', { kind: 'shell', provider: undefined });
        for (const record of [agent, shell]) {
            harness.terminals.set(record.id, record);
            harness.live.add(record.id);
        }
        const landings = Promise.all(
            [agent, shell].map((record) => harness.service.parkLaunch(record)),
        );
        harness.releaseSuspend();
        harness.releaseSuspend();
        await Promise.all([detaching, landings]);

        expect(harness.suspend).toHaveBeenCalledWith('agent-late', 'detached', undefined);
        expect(harness.suspend.mock.calls.map(([terminalId]) => terminalId)).not.toContain(
            'shell-late',
        );
        // The fence drops with the detach: a later launch runs normally.
        harness.live.add('agent-late');
        await harness.service.parkLaunch(agent);
        expect(harness.suspend).toHaveBeenCalledTimes(2);
    });

    it('stops every live Terminal for terminateAll, including a launch that lands meanwhile', async () => {
        const harness = createHarness({ controlledSuspend: true });
        harness.live.delete('terminal-b');
        const terminating = harness.service.terminateAll();
        await vi.waitFor(() => expect(harness.suspend).toHaveBeenCalledTimes(1));
        harness.live.add('terminal-b');
        const landing = harness.service.parkLaunch(harness.terminals.get('terminal-b')!);
        harness.releaseSuspend();
        harness.releaseSuspend();

        expect(await terminating).toEqual(['terminal-a']);
        await landing;
        expect(harness.suspend).toHaveBeenCalledWith('terminal-a', 'stopped', 'userTerminated');
        expect(harness.suspend).toHaveBeenCalledWith('terminal-b', 'stopped', 'userTerminated');
        expect(harness.terminals.get('terminal-b')?.lastProcessState).toBe('stopped');
        // Ending work is not a shutdown: a launch after the terminate keeps running.
        harness.live.add('terminal-a');
        await harness.service.parkLaunch(harness.terminals.get('terminal-a')!);
        expect(harness.suspend).toHaveBeenCalledTimes(2);
    });

    it('parks every live Terminal of an archived Session', async () => {
        const harness = createHarness({ selected: 'session-b' });
        harness.service.start();
        expect(await harness.service.suspendSession('session-a')).toEqual(['terminal-a']);
        expect(harness.terminals.get('terminal-a')?.lastProcessState).toBe('suspended');
        expect(harness.terminals.get('terminal-b')?.lastProcessState).toBe('running');
        expect(await harness.service.suspendSession('session-a')).toEqual([]);
    });

    it('logs a resume only for a parked Agent, never for a Shell that later launches an Agent', async () => {
        const harness = createHarness({ selected: 'session-b' });
        const shell = terminal('shell-a', 'session-a', { kind: 'shell', provider: undefined });
        harness.terminals.set(shell.id, shell);
        harness.live.add(shell.id);
        harness.service.start();
        expect(await harness.service.suspendSession('session-a')).toEqual([
            'terminal-a',
            'shell-a',
        ]);
        harness.service.observeLaunch('shell-a');
        harness.service.observeLaunch('terminal-a');
        expect(
            harness.logs
                .filter(({ event }) => event === 'terminal.resumed')
                .map(({ fields }) => fields.terminalId),
        ).toEqual(['terminal-a']);
    });

    it('logs the resume of an Agent an earlier Server Core parked, whose park time is unknown (#1784)', () => {
        const harness = createHarness({ selected: 'session-b' });
        const parked = {
            lastAgentProcessState: 'suspended',
            lastProcessState: 'suspended',
        } as const;
        harness.terminals.set('terminal-a', terminal('terminal-a', 'session-a', parked));
        // A detached Agent comes back through `session.resume` instead of selection, and counts the same way.
        harness.terminals.set(
            'terminal-c',
            terminal('terminal-c', 'session-a', {
                lastAgentProcessState: 'detached',
                lastProcessState: 'detached',
            }),
        );
        harness.terminals.set(
            'shell-a',
            terminal('shell-a', 'session-a', { ...parked, kind: 'shell', provider: undefined }),
        );
        harness.live.delete('terminal-a');
        harness.service.start();
        harness.service.observeLaunch('shell-a');
        harness.service.observeLaunch('terminal-b');
        harness.service.observeLaunch('terminal-a');
        harness.service.observeLaunch('terminal-c');
        // A later ordinary launch is not another resume.
        harness.service.observeLaunch('terminal-a');
        const resumed = (terminalId: string) => ({
            event: 'terminal.resumed',
            fields: {
                provider: 'claude',
                reason: 'beforeRestart',
                sessionId: 'session-a',
                suspendedForMs: null,
                terminalId,
            },
        });
        expect(harness.logs.filter(({ event }) => event === 'terminal.resumed')).toEqual([
            resumed('terminal-a'),
            resumed('terminal-c'),
        ]);
    });

    it('notices a selection change made outside the select handler at the next sweep', async () => {
        const harness = createHarness({ selected: 'session-a' });
        harness.service.start();
        harness.service.observeLaunch('terminal-a');
        harness.selected = 'session-b';
        harness.advance(UNTOUCHED_SUSPENSION_DELAY_MS);
        // The first sweep only stamps the departure; the grace delay counts from there.
        expect(await harness.service.sweep()).toEqual([]);
        harness.advance(UNTOUCHED_SUSPENSION_DELAY_MS);
        expect(await harness.service.sweep()).toEqual(['terminal-a']);
    });

    it('forgets a launch when its lifecycle is retired', async () => {
        const harness = createHarness({ selected: 'session-b' });
        harness.service.start();
        harness.service.observeLaunch('terminal-a');
        harness.service.forgetTerminal('terminal-a');
        harness.advance(UNTOUCHED_SUSPENSION_DELAY_MS);
        expect(await harness.service.sweep()).toEqual([]);
    });

    // GitHub issue #1427: automatic suspension decides who to suspend from a snapshot of the selected Session taken
    // once at the top of the sweep, but the teardown for each decision is a real async PTY-kill-and-snapshot barrier
    // (`TerminalManager#suspend`). Selecting the Session while that barrier is outstanding used to leave the
    // just-selected Session's Terminal suspended with nothing to notice or retry it.
    describe('reselection race during automatic suspension (issue #1427)', () => {
        it('reconciles a Terminal whose Session is reselected while its own suspend teardown is in flight', async () => {
            const reselected: string[] = [];
            const harness = createHarness({
                controlledSuspend: true,
                onSuspendedSessionReselected: (sessionId) => reselected.push(sessionId),
                selected: 'session-b',
            });
            harness.service.start();
            harness.service.observeLaunch('terminal-a');
            harness.advance(UNTOUCHED_SUSPENSION_DELAY_MS);
            const sweep = harness.service.sweep();
            // The sweep decided to suspend terminal-a (session-a was deselected) and is now paused inside the
            // teardown barrier, exactly where `TerminalManager#suspend` awaits the real PTY kill and snapshot.
            harness.select('session-a');
            harness.releaseSuspend();
            expect(await sweep).toEqual(['terminal-a']);
            // The kill already happened by the time the reselection was noticed, so the record does land `suspended`...
            expect(harness.terminals.get('terminal-a')?.lastProcessState).toBe('suspended');
            // ...but the fence notices the Session is selected again and asks the caller to restore it, converging
            // to running the same way `session.select`'s own restore would if it had run a moment later.
            expect(reselected).toEqual(['session-a']);
        });

        it('skips a still-queued automatic suspend once its Session is reselected before teardown starts', async () => {
            const harness = createHarness({ controlledSuspend: true, selected: 'session-b' });
            // A second live Agent Terminal in session-a, decided for suspension in the same sweep right after
            // terminal-a; its own teardown has not started when the reselection lands.
            harness.terminals.set('terminal-c', terminal('terminal-c', 'session-a'));
            harness.live.add('terminal-c');
            harness.service.start();
            harness.service.observeLaunch('terminal-a');
            harness.service.observeLaunch('terminal-c');
            harness.advance(UNTOUCHED_SUSPENSION_DELAY_MS);
            const sweep = harness.service.sweep();
            harness.select('session-a');
            harness.releaseSuspend();
            expect(await sweep).toEqual(['terminal-a']);
            // terminal-c's suspend is never called at all: the pre-teardown check sees session-a already selected.
            expect(harness.suspend).toHaveBeenCalledTimes(1);
            expect(harness.terminals.get('terminal-c')?.lastProcessState).toBe('running');
        });
    });
});

describe('TerminalSuspensionService: idle suspension', () => {
    const oneMinute = {
        'terminal.idleSuspension.afterMinutes': 1,
        'terminal.idleSuspension.enabled': true,
    } as const;

    /**
     * An Agent in a background Session that ran one turn and finished it, so the untouched rule never applies.
     */
    function finishedTurn(harness: ReturnType<typeof createHarness>) {
        harness.service.start();
        harness.service.observeLaunch('terminal-a');
        harness.service.observeLifecycle({ phase: 'turnStarted', terminalId: 'terminal-a' });
        finishTurn(harness);
    }

    /**
     * The coordinator applies a completion before the runtime forwards the accepted raw hook.
     */
    function finishTurn(harness: ReturnType<typeof createHarness>) {
        const signal = { phase: 'turnFinished', terminalId: 'terminal-a' } as const;
        harness.service.observeAppliedLifecycle(signal);
        harness.service.observeLifecycle(signal);
    }

    it('parks after the configured window and logs the park and the resume with their durations', async () => {
        const harness = createHarness({ settings: oneMinute });
        finishedTurn(harness);
        harness.advance(59_999);
        expect(await harness.service.sweep()).toEqual([]);
        harness.advance(1);
        expect(await harness.service.sweep()).toEqual(['terminal-a']);
        expect(harness.suspend).toHaveBeenCalledWith('terminal-a', 'suspended', 'idleSuspended');
        expect(harness.logs).toContainEqual({
            event: 'terminal.suspended',
            fields: {
                backgroundMs: 60_000,
                idleMs: 60_000,
                provider: 'claude',
                reason: 'idle',
                sessionId: 'session-a',
                terminalId: 'terminal-a',
            },
        });

        // Selecting the Session runs the interrupted-restore path, whose relaunch reports a new launch.
        harness.select('session-a');
        harness.advance(5 * 60_000);
        harness.service.observeLaunch('terminal-a');
        expect(harness.logs).toContainEqual({
            event: 'terminal.resumed',
            fields: {
                provider: 'claude',
                reason: 'idle',
                sessionId: 'session-a',
                suspendedForMs: 5 * 60_000,
                terminalId: 'terminal-a',
            },
        });
        // A later ordinary launch is not another resume.
        harness.service.observeLaunch('terminal-a');
        expect(harness.logs.filter(({ event }) => event === 'terminal.resumed')).toHaveLength(1);
    });

    it('keeps an Agent waiting for a permission until the request resolves', async () => {
        const harness = createHarness({ settings: oneMinute });
        finishedTurn(harness);
        harness.service.observeLifecycle({ phase: 'attentionRequested', terminalId: 'terminal-a' });
        harness.advance(60 * 60_000);
        expect(await harness.service.sweep()).toEqual([]);
        harness.service.observeLifecycle({ phase: 'attentionResolved', terminalId: 'terminal-a' });
        finishTurn(harness);
        harness.advance(60_000);
        expect(await harness.service.sweep()).toEqual(['terminal-a']);
    });

    it('releases an Agent whose permission prompt the user dismissed with Escape', async () => {
        const harness = createHarness({ settings: oneMinute });
        harness.service.start();
        harness.service.observeLaunch('terminal-a');
        harness.service.observeLifecycle({ phase: 'turnStarted', terminalId: 'terminal-a' });
        harness.service.observeLifecycle({ phase: 'attentionRequested', terminalId: 'terminal-a' });
        // Claude sends no Stop for an interrupted turn, so the Escape is the only end the turn gets.
        harness.service.observeInput('terminal-a', '\u{1B}');
        harness.advance(60_000);
        expect(await harness.service.sweep()).toEqual(['terminal-a']);
    });

    it('keeps an Agent mid-turn once a tool signal follows an Escape that did not interrupt it (#1785)', async () => {
        const harness = createHarness({ settings: oneMinute });
        harness.service.start();
        harness.service.observeLaunch('terminal-a');
        harness.service.observeLifecycle({ phase: 'turnStarted', terminalId: 'terminal-a' });
        // The Escape only closed a completion menu; the long Bash command it started keeps running silently.
        harness.service.observeInput('terminal-a', '\u{1B}');
        harness.service.observeLifecycle({ phase: 'shellToolStarted', terminalId: 'terminal-a' });
        harness.advance(60 * 60_000);
        expect(await harness.service.sweep()).toEqual([]);
        finishTurn(harness);
        harness.advance(60_000);
        expect(await harness.service.sweep()).toEqual(['terminal-a']);
    });

    it('still parks an Agent the Escape really interrupted, even after a subagent signal', async () => {
        const harness = createHarness({ settings: oneMinute });
        harness.service.start();
        harness.service.observeLaunch('terminal-a');
        harness.service.observeLifecycle({ phase: 'turnStarted', terminalId: 'terminal-a' });
        harness.service.observeLifecycle({ phase: 'toolBatchFinished', terminalId: 'terminal-a' });
        harness.service.observeInput('terminal-a', '\u{1B}');
        // A subagent's tool proves nothing about the main turn the user interrupted.
        harness.service.observeLifecycle({
            agentId: 'subagent-1',
            phase: 'shellToolFinished',
            terminalId: 'terminal-a',
        });
        harness.advance(60_000);
        expect(await harness.service.sweep()).toEqual(['terminal-a']);
    });

    it('keeps a parent whose completion the coordinator deferred for its background subagents', async () => {
        const harness = createHarness({ settings: oneMinute });
        harness.service.start();
        harness.service.observeLaunch('terminal-a');
        harness.service.observeLifecycle({ phase: 'turnStarted', terminalId: 'terminal-a' });
        // The raw Stop is accepted, but the coordinator holds the completion until the subagents finish.
        harness.service.observeLifecycle({ phase: 'turnFinished', terminalId: 'terminal-a' });
        harness.advance(60 * 60_000);
        expect(await harness.service.sweep()).toEqual([]);
        harness.service.observeAppliedLifecycle({
            phase: 'turnFinished',
            terminalId: 'terminal-a',
        });
        harness.advance(60_000);
        expect(await harness.service.sweep()).toEqual(['terminal-a']);
    });

    it('does not treat a finished subagent as the end of the main turn', async () => {
        const harness = createHarness({ settings: oneMinute });
        harness.service.start();
        harness.service.observeLaunch('terminal-a');
        harness.service.observeLifecycle({ phase: 'turnStarted', terminalId: 'terminal-a' });
        harness.service.observeLifecycle({
            agentId: 'subagent-1',
            phase: 'turnFinished',
            terminalId: 'terminal-a',
        });
        harness.advance(60 * 60_000);
        expect(await harness.service.sweep()).toEqual([]);
    });

    it('leaves a Terminal a phone is observing running', async () => {
        const harness = createHarness({ settings: oneMinute });
        finishedTurn(harness);
        harness.observedRemotely.add('terminal-a');
        harness.advance(60 * 60_000);
        expect(await harness.service.sweep()).toEqual([]);
        harness.observedRemotely.delete('terminal-a');
        expect(await harness.service.sweep()).toEqual(['terminal-a']);
    });

    it('leaves an Agent whose Conversation a phone has open running', async () => {
        const harness = createHarness({ settings: oneMinute });
        finishedTurn(harness);
        harness.conversationWatched.add('terminal-a');
        harness.advance(60 * 60_000);
        expect(await harness.service.sweep()).toEqual([]);
        harness.conversationWatched.delete('terminal-a');
        expect(await harness.service.sweep()).toEqual(['terminal-a']);
    });

    it('never parks while the setting is off, which is the default', async () => {
        const harness = createHarness();
        finishedTurn(harness);
        harness.advance(24 * 60 * 60_000);
        expect(await harness.service.sweep()).toEqual([]);
    });
});
