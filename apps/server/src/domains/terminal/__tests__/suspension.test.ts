import type { AppSettings, ServerEvent, SessionRecord, TerminalRecord } from '@caxri/protocol';
import { defaultAppSettings } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { PollerRegistrationOptions } from '../../watch-hub';
import { TerminalSuspensionService } from '../suspension';
import { UNTOUCHED_SUSPENSION_DELAY_MS } from '../suspension-policy';

const START = 10_000_000;

function terminal(id: string, sessionId: string, overrides: Partial<TerminalRecord> = {}) {
    return {
        id,
        sessionId,
        kind: 'claude',
        provider: 'claude',
        cwd: '/tmp/project',
        title: 'claude',
        icon: 'claude',
        orderIndex: 0,
        lastProcessState: 'running',
        lastAgentProcessState: 'running',
        createdAt: START,
        updatedAt: START,
        ...overrides,
    } as TerminalRecord;
}

function session(id: string, primaryAgentTerminalId: string) {
    return {
        id,
        projectId: 'project-1',
        title: id,
        lastActivityState: 'completed',
        primaryAgentTerminalId,
        attentionEpoch: 0,
        readAttentionEpoch: 0,
        hasUnread: false,
        createdAt: START,
        updatedAt: START,
    } as unknown as SessionRecord;
}

function createHarness(
    options: {
        commanderSessionId?: string;
        selected?: string;
        settings?: Partial<AppSettings>;
    } = {},
) {
    let now = START;
    let selected = options.selected ?? 'session-b';
    const sessions = new Map([
        ['session-a', session('session-a', 'terminal-a')],
        ['session-b', session('session-b', 'terminal-b')],
    ]);
    const terminals = new Map([
        ['terminal-a', terminal('terminal-a', 'session-a')],
        ['terminal-b', terminal('terminal-b', 'session-b')],
    ]);
    const live = new Set(terminals.keys());
    const events: ServerEvent[] = [];
    let poller: PollerRegistrationOptions | undefined;
    const suspend = vi.fn((terminalId: string, state: 'suspended' | 'detached' = 'suspended') => {
        if (!live.has(terminalId)) return Promise.resolve(undefined);
        live.delete(terminalId);
        const record = terminals.get(terminalId)!;
        const suspended = terminal(terminalId, record.sessionId, {
            lastAgentProcessState: state,
            lastProcessState: state,
        });
        terminals.set(terminalId, suspended);
        return Promise.resolve(suspended);
    });
    const service = new TerminalSuspensionService({
        database: {
            agentCommanderRows: () =>
                options.commanderSessionId && { sessionId: options.commanderSessionId },
            getSession: (id: string) => sessions.get(id),
            listSessions: () => sessions.values().toArray(),
            listTerminals: (sessionId?: string) =>
                terminals
                    .values()
                    .filter((record) => sessionId === undefined || record.sessionId === sessionId)
                    .toArray(),
        } as never,
        logger: { write: vi.fn() } as never,
        now: () => now,
        selectedSessionId: () => selected,
        send: (event) => events.push(event),
        settings: () => ({ ...defaultAppSettings, ...options.settings }),
        terminals: {
            processId: (terminalId: string) => (live.has(terminalId) ? 4242 : undefined),
            suspend,
        },
        watchHub: {
            registerPoller: (registration) => {
                poller = registration;
                return { dispose: vi.fn(async () => {}), label: registration.label } as never;
            },
        },
    });
    return {
        advance: (ms: number) => {
            now += ms;
        },
        set selected(sessionId: string) {
            selected = sessionId;
        },
        events,
        live,
        poller: () => poller,
        select: (sessionId: string) => {
            selected = sessionId;
            service.observeSelection();
        },
        service,
        suspend,
        terminals,
    };
}

describe('TerminalSuspensionService', () => {
    it('does not suspend a starting Agent before lifecycle activation on an old Server', async () => {
        const harness = createHarness({ settings: { 'terminal.suspendIdleAgents': '30m' } });
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
        harness.service.observeInput('terminal-a');
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
            settings: { 'terminal.suspendIdleAgents': '30m' },
        });
        harness.service.start();
        harness.service.observeLaunch('terminal-a');
        await harness.service.detachSession('session-a');
        harness.select('session-b');
        harness.advance(60 * 60 * 1000);
        expect(await harness.service.sweep()).toEqual([]);
        expect(harness.terminals.get('terminal-a')?.lastProcessState).toBe('detached');
    });

    it('parks every live Terminal of an archived Session', async () => {
        const harness = createHarness({ selected: 'session-b' });
        harness.service.start();
        expect(await harness.service.suspendSession('session-a')).toEqual(['terminal-a']);
        expect(harness.terminals.get('terminal-a')?.lastProcessState).toBe('suspended');
        expect(harness.terminals.get('terminal-b')?.lastProcessState).toBe('running');
        expect(await harness.service.suspendSession('session-a')).toEqual([]);
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
});
