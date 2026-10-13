import type { AppSettings, ServerEvent, SessionRecord, TerminalRecord } from '@caxri/protocol';
import { defaultAppSettings } from '@caxri/protocol';
import { vi } from 'vitest';

import type { PollerRegistrationOptions } from '../../watch';
import { TerminalSuspensionService } from '../suspension';

const START = 10_000_000;

export const idleAfterThirtyMinutes = {
    'terminal.idleSuspension.afterMinutes': 30,
    'terminal.idleSuspension.enabled': true,
} as const;

type ParkedState = 'detached' | 'stopped' | 'suspended';

export function terminal(id: string, sessionId: string, overrides: Partial<TerminalRecord> = {}) {
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

/**
 * A `TerminalSuspensionService` over two background-capable Sessions (`session-a`, `session-b`), each with one live
 * Claude Agent Terminal, an injectable clock, and in-memory fakes for the database, logger, and Terminal manager.
 */
export function createHarness(
    options: {
        chats?: ConstructorParameters<typeof TerminalSuspensionService>[0]['chats'];
        commanderSessionId?: string;
        /**
         * When set, every `terminals.suspend` call pauses instead of resolving immediately, standing in for the real
         * PTY-kill-and-snapshot teardown that `TerminalManager#suspend` awaits. A test drains the queue explicitly with
         * `releaseSuspend()` to control exactly what happens while that await is outstanding.
         */
        controlledSuspend?: boolean;
        onSuspendedSessionReselected?: (sessionId: string) => void;
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
    const observedRemotely = new Set<string>();
    const conversationWatched = new Set<string>();
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const events: ServerEvent[] = [];
    let poller: PollerRegistrationOptions | undefined;
    const pendingSuspends: Array<() => void> = [];
    const suspend = vi.fn((terminalId: string, state: ParkedState = 'suspended') => {
        if (!live.has(terminalId)) return Promise.resolve(undefined);
        const finish = () => {
            live.delete(terminalId);
            const record = terminals.get(terminalId)!;
            const suspended = {
                ...record,
                lastAgentProcessState: state,
                lastProcessState: state,
            };
            terminals.set(terminalId, suspended);
            return suspended;
        };
        if (!options.controlledSuspend) return Promise.resolve(finish());
        return new Promise<TerminalRecord>((resolve) => {
            pendingSuspends.push(() => resolve(finish()));
        });
    });
    const service = new TerminalSuspensionService({
        database: {
            getAppState: () =>
                options.commanderSessionId && {
                    projectId: 'project-1',
                    sessionId: options.commanderSessionId,
                    sessionIds: [],
                },
            getProject: () => ({ hiddenAt: undefined }),
            getSession: (id: string) => sessions.get(id),
            getTerminal: (id: string) => terminals.get(id),
            listSessions: () => sessions.values().toArray(),
            listTerminals: (sessionId?: string) =>
                terminals
                    .values()
                    .filter((record) => sessionId === undefined || record.sessionId === sessionId)
                    .toArray(),
        } as never,
        logger: {
            write: (_level: string, event: string, entry?: { fields?: Record<string, unknown> }) =>
                logs.push({ event, fields: entry?.fields ?? {} }),
        } as never,
        chats: options.chats,
        now: () => now,
        onSuspendedSessionReselected: options.onSuspendedSessionReselected,
        selectedSessionId: () => selected,
        send: (event) => events.push(event),
        settings: () => ({ ...defaultAppSettings, ...options.settings }),
        remoteObservers: [
            { isObservedRemotely: (terminalId: string) => observedRemotely.has(terminalId) },
            { isObservedRemotely: (terminalId: string) => conversationWatched.has(terminalId) },
        ],
        terminals: {
            processId: (terminalId: string) => (live.has(terminalId) ? 4242 : undefined),
            settleLaunches: () => Promise.resolve(),
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
        conversationWatched,
        events,
        live,
        logs,
        observedRemotely,
        poller: () => poller,
        /**
         * Resolves the oldest still-pending `terminals.suspend` call created while `controlledSuspend` is set.
         */
        releaseSuspend: () => {
            const next = pendingSuspends.shift();
            if (!next) throw new Error('no pending suspend to release');
            next();
        },
        select: (sessionId: string) => {
            selected = sessionId;
            service.observeSelection();
        },
        service,
        suspend,
        terminals,
    };
}
