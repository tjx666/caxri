import { describe, expect, it } from 'vitest';

import type { SessionRecord, SessionState, TerminalRecord } from '../../shared/types';
import { createTerminalLayout, splitTerminal } from '../../shared/terminal-layout';
import {
    choosePrimaryAgentForNewTerminal,
    choosePrimaryAgentSuccessor,
    decideAgentMetadataUpdate,
    defaultTerminalTitle,
    processActivityState,
    selectFallbackAfterDeletion,
    shutdownOutcome,
    withTerminalRemovedFromLayout,
} from '../session-policy';

function terminal(overrides: Partial<TerminalRecord> = {}): TerminalRecord {
    return {
        id: 'terminal-1',
        sessionId: 'session-1',
        kind: 'shell',
        provider: undefined,
        cwd: '/repo',
        title: 'Shell',
        icon: 'shell',
        orderIndex: 0,
        layoutNodeId: 'layout-1',
        agentSessionId: undefined,
        lastProcessState: 'running',
        createdAt: 0,
        updatedAt: 0,
        ...overrides,
    };
}

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
        id: 'session-1',
        projectId: 'project-1',
        rootPath: '/repo',
        createdAt: 0,
        lastOpenedAt: 0,
        primaryAgentTerminalId: undefined,
        lastActivityState: 'idle',
        layoutVersion: 2,
        displayTitle: 'Shell',
        ...overrides,
    };
}

describe('defaultTerminalTitle', () => {
    it('maps each Terminal kind to its default title', () => {
        expect(defaultTerminalTitle('shell')).toBe('Shell');
        expect(defaultTerminalTitle('claude')).toBe('Claude Code');
        expect(defaultTerminalTitle('codex')).toBe('Codex');
    });
});

describe('processActivityState', () => {
    it('maps process lifecycle states onto Agent activity states', () => {
        expect(processActivityState('starting')).toBe('running');
        expect(processActivityState('running')).toBe('running');
        expect(processActivityState('stopped')).toBe('completed');
        expect(processActivityState('dead')).toBe('failed');
        expect(processActivityState('failed')).toBe('failed');
    });
});

describe('shutdownOutcome', () => {
    it('maps an unclean shutdown to interrupted Terminals and a failed primary Agent Session', () => {
        expect(shutdownOutcome('unclean')).toEqual({
            liveProcessStates: ['running', 'starting'],
            terminalProcessState: 'interrupted',
            primaryAgentSessionState: 'failed',
        });
    });

    it('maps an orderly shutdown to interrupted Terminals and a completed primary Agent Session', () => {
        expect(shutdownOutcome('orderly')).toEqual({
            liveProcessStates: ['running', 'starting'],
            terminalProcessState: 'interrupted',
            primaryAgentSessionState: 'completed',
        });
    });

    it('maps an explicit terminate shutdown to stopped Terminals and a completed primary Agent Session', () => {
        expect(shutdownOutcome('terminate')).toEqual({
            liveProcessStates: ['running', 'starting'],
            terminalProcessState: 'stopped',
            primaryAgentSessionState: 'completed',
        });
    });
});

describe('choosePrimaryAgentForNewTerminal', () => {
    it('promotes a new Agent Terminal when the Session has none yet', () => {
        const assignment = choosePrimaryAgentForNewTerminal(
            session({ primaryAgentTerminalId: undefined }),
            terminal({ id: 'codex-1', kind: 'codex' }),
        );
        expect(assignment).toEqual({
            primaryAgentTerminalId: 'codex-1',
            displayTitle: 'Codex',
            lastActivityState: 'idle',
        });
    });

    it('never promotes a shell Terminal', () => {
        expect(
            choosePrimaryAgentForNewTerminal(
                session({ primaryAgentTerminalId: undefined }),
                terminal({ id: 'shell-1', kind: 'shell' }),
            ),
        ).toBeUndefined();
    });

    it('does not replace an existing primary Agent Terminal', () => {
        expect(
            choosePrimaryAgentForNewTerminal(
                session({ primaryAgentTerminalId: 'codex-1' }),
                terminal({ id: 'claude-1', kind: 'claude' }),
            ),
        ).toBeUndefined();
    });
});

describe('choosePrimaryAgentSuccessor', () => {
    it('promotes the next Agent Terminal in the Session', () => {
        const claude = terminal({
            id: 'claude-1',
            kind: 'claude',
            provider: 'claude',
            title: 'Claude Code',
            lastProcessState: 'running',
        });
        expect(choosePrimaryAgentSuccessor([terminal({ id: 'shell-1' }), claude])).toEqual({
            primaryAgentTerminalId: 'claude-1',
            displayTitle: 'Claude Code',
            lastActivityState: 'running',
        });
    });

    it('falls back to any remaining Terminal when no Agent Terminal remains', () => {
        const shell = terminal({ id: 'shell-1', title: 'Shell' });
        expect(choosePrimaryAgentSuccessor([shell])).toEqual({
            primaryAgentTerminalId: null,
            displayTitle: 'Shell',
            lastActivityState: 'idle',
        });
    });

    it('resets to an untitled idle Session when no Terminal remains', () => {
        expect(choosePrimaryAgentSuccessor([])).toEqual({
            primaryAgentTerminalId: null,
            displayTitle: 'Session',
            lastActivityState: 'idle',
        });
    });
});

describe('decideAgentMetadataUpdate', () => {
    it('ignores a snapshot from a different provider than the Terminal', () => {
        const decision = decideAgentMetadataUpdate(terminal({ provider: 'codex' }), session(), {
            provider: 'claude',
            available: true,
            observedAt: 0,
            status: 'running',
        });
        expect(decision).toBeUndefined();
    });

    it('updates the Session title and status only when the Terminal is the primary Agent', () => {
        const primary = terminal({ id: 'codex-1', provider: 'codex' });
        const decision = decideAgentMetadataUpdate(
            primary,
            session({
                primaryAgentTerminalId: 'codex-1',
                displayTitle: 'Codex',
                lastActivityState: 'idle',
            }),
            {
                provider: 'codex',
                available: true,
                observedAt: 0,
                status: 'running',
                sessionId: 'agent-session-1',
                title: 'Run the development server',
            },
        );
        expect(decision).toEqual({
            agentSessionId: 'agent-session-1',
            sessionPatch: {
                displayTitle: 'Run the development server',
                lastActivityState: 'running',
            },
        });
    });

    it('updates only the Terminal agentSessionId for a non-primary Agent Terminal', () => {
        const secondary = terminal({ id: 'claude-1', provider: 'claude' });
        const decision = decideAgentMetadataUpdate(
            secondary,
            session({
                primaryAgentTerminalId: 'codex-1',
                displayTitle: 'Codex',
                lastActivityState: 'idle',
            }),
            {
                provider: 'claude',
                available: true,
                observedAt: 0,
                status: 'waiting',
                sessionId: 'claude-session-1',
                title: 'Do not replace the first Agent title',
            },
        );
        expect(decision).toEqual({ agentSessionId: 'claude-session-1', sessionPatch: undefined });
    });

    it('is a no-op when the snapshot changes nothing observable', () => {
        const primary = terminal({
            id: 'codex-1',
            provider: 'codex',
            agentSessionId: 'agent-session-1',
        });
        const decision = decideAgentMetadataUpdate(
            primary,
            session({
                primaryAgentTerminalId: 'codex-1',
                displayTitle: 'Codex',
                lastActivityState: 'running',
            }),
            {
                provider: 'codex',
                available: true,
                observedAt: 0,
                status: 'running',
                sessionId: 'agent-session-1',
                title: 'Codex',
            },
        );
        expect(decision).toBeUndefined();
    });
});

describe('selectFallbackAfterDeletion', () => {
    it('prefers the projectId of the fallback Session over the given fallback Project', () => {
        const fallbackSession = session({ id: 'session-2', projectId: 'project-2' });
        expect(selectFallbackAfterDeletion(fallbackSession, 'project-1')).toEqual({
            projectId: 'project-2',
            sessionId: 'session-2',
        });
    });

    it('falls back to the given Project id when no Session candidate exists', () => {
        expect(selectFallbackAfterDeletion(undefined, 'project-1')).toEqual({
            projectId: 'project-1',
            sessionId: null,
        });
    });

    it('clears the selection entirely when nothing remains', () => {
        expect(selectFallbackAfterDeletion(undefined, null)).toEqual({
            projectId: null,
            sessionId: null,
        });
    });
});

describe('withTerminalRemovedFromLayout', () => {
    it('composes the shared pure layout helper instead of editing layout JSON inline', () => {
        const layout = createTerminalLayout('terminal-1');
        const split = splitTerminal(layout, 'terminal-2', layout.activeGroupId!, 'vertical');
        const state: SessionState = {
            sessionId: 'session-1',
            openTabs: [],
            inspectorMode: 'files',
            layout: split,
        };

        const next = withTerminalRemovedFromLayout(state, 'terminal-2');

        expect(next).not.toBe(state);
        expect(next.layout).not.toBe(state.layout);
        expect(next.openTabs).toBe(state.openTabs);
    });
});
