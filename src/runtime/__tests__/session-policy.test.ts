import { describe, expect, it } from 'vitest';

import { agentProviderCatalog, agentProviderIds } from '../../shared/agents';
import { createPaneLayout, openResource } from '../../shared/pane-layout';
import type { SessionRecord, SessionState, TerminalRecord } from '../../shared/types';
import {
    choosePrimaryAgentForNewTerminal,
    choosePrimaryAgentSuccessor,
    decideAgentMetadataUpdate,
    DEFAULT_SESSION_TITLE,
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
        workbenchProjectId: 'project-1',
        rootPath: '/repo',
        createdAt: 0,
        lastOpenedAt: 0,
        primaryAgentTerminalId: undefined,
        lastActivityState: 'idle',
        attentionEpoch: 0,
        readAttentionEpoch: 0,
        lastAttentionKind: undefined,
        hasUnread: false,
        layoutVersion: 2,
        displayTitle: DEFAULT_SESSION_TITLE,
        titleMode: 'automatic',
        ...overrides,
    };
}

describe('defaultTerminalTitle', () => {
    it('keeps the new Session title distinct from provider-specific Terminal titles', () => {
        expect(DEFAULT_SESSION_TITLE).toBe('Untitled');
    });

    it('derives every managed provider title from the catalog while Shell stays local', () => {
        expect(defaultTerminalTitle('shell')).toBe('Shell');
        for (const provider of agentProviderIds)
            expect(defaultTerminalTitle(provider)).toBe(agentProviderCatalog[provider].displayName);
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
            displayTitle: 'Untitled',
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

    it('promotes the first Agent without replacing a manual Session title', () => {
        expect(
            choosePrimaryAgentForNewTerminal(
                session({
                    displayTitle: 'My investigation',
                    primaryAgentTerminalId: undefined,
                    titleMode: 'manual',
                }),
                terminal({ id: 'codex-1', kind: 'codex' }),
            ),
        ).toMatchObject({ displayTitle: 'My investigation' });
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
        expect(
            choosePrimaryAgentSuccessor(
                [terminal({ id: 'shell-1' }), claude],
                session({ displayTitle: 'Existing' }),
            ),
        ).toEqual({
            primaryAgentTerminalId: 'claude-1',
            displayTitle: 'Existing',
            lastActivityState: 'running',
        });
    });

    it('keeps the generated Session title when only Shell Terminals remain', () => {
        const shell = terminal({ id: 'shell-1', title: 'Shell' });
        expect(choosePrimaryAgentSuccessor([shell], session({ displayTitle: 'Existing' }))).toEqual(
            {
                primaryAgentTerminalId: null,
                displayTitle: 'Existing',
                lastActivityState: 'idle',
            },
        );
    });

    it('keeps the generated Session title when no Terminal remains', () => {
        expect(
            choosePrimaryAgentSuccessor([], session({ displayTitle: 'Keep this title' })),
        ).toEqual({
            primaryAgentTerminalId: null,
            displayTitle: 'Keep this title',
            lastActivityState: 'idle',
        });
    });

    it('preserves a manual title while promoting another primary Agent', () => {
        const claude = terminal({
            id: 'claude-1',
            kind: 'claude',
            provider: 'claude',
            title: 'Claude Code',
        });
        expect(
            choosePrimaryAgentSuccessor(
                [claude],
                session({ displayTitle: 'Keep me', titleMode: 'manual' }),
            ),
        ).toMatchObject({ displayTitle: 'Keep me', primaryAgentTerminalId: 'claude-1' });
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

    it('emits only reliable primary-Agent attention state transitions', () => {
        const primary = terminal({ id: 'claude-1', provider: 'claude' });
        const current = session({
            primaryAgentTerminalId: primary.id,
            lastActivityState: 'running',
        });

        expect(
            decideAgentMetadataUpdate(primary, current, {
                provider: 'claude',
                attentionKind: 'waiting',
                available: true,
                observedAt: 0,
                status: 'waiting',
            })?.sessionPatch,
        ).toMatchObject({ attentionKind: 'waiting', lastActivityState: 'waiting' });
        expect(
            decideAgentMetadataUpdate(
                primary,
                session({
                    primaryAgentTerminalId: primary.id,
                    lastActivityState: 'waiting',
                    lastAttentionKind: 'waiting',
                }),
                {
                    provider: 'claude',
                    attentionKind: 'waiting',
                    available: true,
                    observedAt: 0,
                    status: 'waiting',
                },
            ),
        ).toBeUndefined();
        expect(
            decideAgentMetadataUpdate(
                terminal({ id: 'codex-1', provider: 'codex' }),
                session({ primaryAgentTerminalId: 'codex-1', lastActivityState: 'running' }),
                {
                    provider: 'codex',
                    available: true,
                    observedAt: 0,
                    status: 'completed',
                },
            )?.sessionPatch?.attentionKind,
        ).toBeUndefined();
    });

    it('removes leading image placeholders from an Agent-generated Session title', () => {
        const primary = terminal({ id: 'codex-1', provider: 'codex' });
        const decision = decideAgentMetadataUpdate(
            primary,
            session({ primaryAgentTerminalId: 'codex-1', displayTitle: 'Codex' }),
            {
                provider: 'codex',
                available: true,
                observedAt: 0,
                status: 'running',
                title: '[Image #1] [Image #27] Fix the terminal startup',
            },
        );
        expect(decision?.sessionPatch?.displayTitle).toBe('Fix the terminal startup');
    });

    it('keeps the previous title when metadata contains only image placeholders', () => {
        const primary = terminal({ id: 'codex-1', provider: 'codex' });
        const decision = decideAgentMetadataUpdate(
            primary,
            session({ primaryAgentTerminalId: 'codex-1', displayTitle: 'Codex' }),
            {
                provider: 'codex',
                available: true,
                observedAt: 0,
                status: 'running',
                title: '[image #1]',
            },
        );
        expect(decision?.sessionPatch?.displayTitle).toBe('Codex');
    });

    it('does not remove image placeholders from the middle of a title', () => {
        const primary = terminal({ id: 'codex-1', provider: 'codex' });
        const decision = decideAgentMetadataUpdate(
            primary,
            session({ primaryAgentTerminalId: 'codex-1', displayTitle: 'Codex' }),
            {
                provider: 'codex',
                available: true,
                observedAt: 0,
                status: 'running',
                title: 'Explain [Image #1] in the terminal',
            },
        );
        expect(decision?.sessionPatch?.displayTitle).toBe('Explain [Image #1] in the terminal');
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

    it('updates activity and Agent identity without overwriting a manual title', () => {
        const decision = decideAgentMetadataUpdate(
            terminal({ id: 'codex-1', provider: 'codex' }),
            session({
                displayTitle: 'Manual name',
                lastActivityState: 'idle',
                primaryAgentTerminalId: 'codex-1',
                titleMode: 'manual',
            }),
            {
                provider: 'codex',
                available: true,
                observedAt: 0,
                status: 'waiting',
                sessionId: 'agent-session-2',
                title: 'Agent replacement title',
            },
        );

        expect(decision).toEqual({
            agentSessionId: 'agent-session-2',
            sessionPatch: { displayTitle: 'Manual name', lastActivityState: 'waiting' },
        });
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
    it('composes the shared pure pane layout reducer instead of editing the tree inline', () => {
        const layout = createPaneLayout({ kind: 'terminal', terminalId: 'terminal-1' });
        const paneLayout = openResource(layout, { kind: 'terminal', terminalId: 'terminal-2' });
        const state: SessionState = {
            sessionId: 'session-1',
            workbenchProjectId: 'project-1',
            desiredSecondarySidebarViewContainerId: 'caxri.files',
            paneLayout,
        };

        const next = withTerminalRemovedFromLayout(state, 'terminal-2');

        expect(next).not.toBe(state);
        expect(next.paneLayout).not.toBe(state.paneLayout);
    });
});
