import type { ProjectRecord, SessionRecord, SessionState, TerminalRecord } from '@caxri/protocol';
import {
    agentProviderCatalog,
    agentProviderIds,
    createPaneLayout,
    openResource,
} from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    choosePrimaryAgentForNewTerminal,
    choosePrimaryAgentSuccessor,
    decideAgentMetadataUpdate,
    DEFAULT_SESSION_TITLE,
    defaultTerminalTitle,
    firstSelectableProject,
    processExitActivityState,
    selectFallbackAfterDeletion,
    sessionActivityReasonForAgentState,
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
        sidebarOrder: 0,
        lastSessionActivityAt: 0,
        lastSessionActivityReason: 'created',
        primaryAgentTerminalId: undefined,
        lastActivityState: 'idle',
        attentionEpoch: 0,
        readAttentionEpoch: 0,
        lastAttentionKind: undefined,
        hasUnread: false,
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

describe('processExitActivityState', () => {
    it('maps real child-process exits onto Agent activity states', () => {
        expect(processExitActivityState('stopped')).toBe('completed');
        expect(processExitActivityState('dead')).toBe('failed');
    });
});

describe('sessionActivityReasonForAgentState', () => {
    it('maps only meaningful Primary Agent states onto Session Activity', () => {
        expect(sessionActivityReasonForAgentState('running')).toBe('agent_started');
        expect(sessionActivityReasonForAgentState('waiting')).toBe('agent_waiting');
        expect(sessionActivityReasonForAgentState('completed')).toBe('agent_completed');
        expect(sessionActivityReasonForAgentState('failed')).toBe('agent_failed');
        expect(sessionActivityReasonForAgentState('idle')).toBeUndefined();
        expect(sessionActivityReasonForAgentState('unknown')).toBeUndefined();
    });
});

describe('shutdownOutcome', () => {
    /**
     * Caxri crashing says nothing about any Agent conversation, so an unclean shutdown records the interruption on the
     * Terminals and leaves every Session's own activity state untouched.
     */
    it('maps an unclean shutdown to interrupted Terminals and no Session state at all', () => {
        expect(shutdownOutcome('unclean')).toEqual({
            liveProcessStates: ['running', 'starting'],
            terminalProcessState: 'interrupted',
        });
    });

    it('maps an orderly shutdown to interrupted Terminals without changing Session activity', () => {
        expect(shutdownOutcome('orderly')).toEqual({
            liveProcessStates: ['running', 'starting'],
            terminalProcessState: 'interrupted',
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
            lastActivityState: 'unknown',
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
            terminalTitle: 'Run the development server',
            sessionPatch: {
                displayTitle: 'Run the development server',
                lastActivityState: 'running',
            },
        });
    });

    /**
     * Codex reports no thread name until the model writes one, and Caxri refuses to read the provisional first-prompt
     * value. The sidebar keeps the neutral default rather than a provider-derived stand-in: the row already carries the
     * provider icon, so a substitute title would add nothing there.
     */
    it('keeps the neutral default when the probe carries no verified title', () => {
        const primary = terminal({ id: 'codex-1', provider: 'codex' });
        const decision = decideAgentMetadataUpdate(
            primary,
            session({ primaryAgentTerminalId: 'codex-1', displayTitle: DEFAULT_SESSION_TITLE }),
            { provider: 'codex', available: true, observedAt: 0, status: 'running' },
        );
        expect(decision?.sessionPatch?.displayTitle).toBe(DEFAULT_SESSION_TITLE);
    });

    it('never replaces a real title when the probe carries no verified title', () => {
        const primary = terminal({ id: 'codex-1', provider: 'codex' });
        const decision = decideAgentMetadataUpdate(
            primary,
            session({ primaryAgentTerminalId: 'codex-1', displayTitle: 'Investigate hooks' }),
            { provider: 'codex', available: true, observedAt: 0, status: 'running' },
        );
        expect(decision?.sessionPatch?.displayTitle).toBe('Investigate hooks');
    });

    it('leaves an Agent Terminal title alone when the probe reports no usable title', () => {
        const primary = terminal({ id: 'claude-1', provider: 'claude', title: '~/code/caxri' });
        const decision = decideAgentMetadataUpdate(
            primary,
            session({ primaryAgentTerminalId: 'claude-1', lastActivityState: 'idle' }),
            {
                provider: 'claude',
                available: true,
                observedAt: 0,
                status: 'running',
                title: ' '.repeat(3),
            },
        );
        expect(decision?.terminalTitle).toBeUndefined();
    });

    // Claude Code writes `status: "idle"` at launch before any turn runs; that must not read as "waiting for the user".
    it('keeps the current state when a probe reports waiting for a Session that never ran a turn', () => {
        const primary = terminal({ id: 'c1', provider: 'claude', title: 'Investigate hooks' });
        for (const lastActivityState of ['idle', 'unknown', 'completed'] as const) {
            const decision = decideAgentMetadataUpdate(
                primary,
                // A real title keeps the provider placeholder out of this attention-only assertion.
                session({
                    displayTitle: 'Investigate hooks',
                    primaryAgentTerminalId: primary.id,
                    lastActivityState,
                }),
                {
                    provider: 'claude',
                    attentionKind: 'waiting',
                    available: true,
                    observedAt: 0,
                    status: 'waiting',
                },
            );
            expect(decision).toBeUndefined();
        }
    });

    /**
     * A probe reads Claude Code's coarse `status: "idle"`, which cannot distinguish "blocked on the user" from "the
     * turn finished and the prompt is empty". Persisting that as `waiting` relights the PrimarySidebar's
     * acknowledged-waiting cue, and that cue never consults read state, so the row stays amber forever for a Session
     * the user already read.
     */
    it('never relights an acknowledged finished Session with an unclearable waiting cue', () => {
        const primary = terminal({ id: 'claude-1', provider: 'claude' });
        const acknowledged = session({
            primaryAgentTerminalId: primary.id,
            lastActivityState: 'completed',
            lastAttentionKind: 'completed',
            attentionEpoch: 3,
            readAttentionEpoch: 3,
        });

        const decision = decideAgentMetadataUpdate(primary, acknowledged, {
            provider: 'claude',
            attentionKind: 'waiting',
            available: true,
            observedAt: 0,
            status: 'waiting',
        });

        expect(decision?.sessionPatch?.attentionKind).toBeUndefined();
        expect(decision?.sessionPatch?.lastActivityState).not.toBe('waiting');
    });

    /**
     * `failed` no longer arrives in bulk from an unclean shutdown, but a provider-reported turn failure and a crashed
     * Agent process still write it. A recovered Agent answering probes again must still be able to move off it.
     */
    it('lets a probe clear a failure marker on a recovered Session', () => {
        const primary = terminal({ id: 'claude-1', provider: 'claude' });

        expect(
            decideAgentMetadataUpdate(
                primary,
                session({ primaryAgentTerminalId: primary.id, lastActivityState: 'failed' }),
                {
                    provider: 'claude',
                    attentionKind: 'completed',
                    available: true,
                    observedAt: 0,
                    status: 'completed',
                },
            )?.sessionPatch,
        ).toMatchObject({ lastActivityState: 'completed' });
    });

    it('emits only reliable primary-Agent attention state transitions', () => {
        const primary = terminal({ id: 'c1', provider: 'claude', title: 'Investigate hooks' });
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
                    displayTitle: 'Investigate hooks',
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

    it('retitles a non-primary Agent Terminal without touching the Session title', () => {
        const secondary = terminal({ id: 'claude-1', provider: 'claude', title: 'Claude' });
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
        expect(decision).toEqual({
            agentSessionId: 'claude-session-1',
            terminalTitle: 'Do not replace the first Agent title',
            sessionPatch: undefined,
        });
    });

    /**
     * The primary Agent's tab is the Session's own face, so a name the user typed wins there too. Letting the tab
     * follow the Agent's conversation name instead left the sidebar row and the tab showing two different names for one
     * Session.
     */
    it('keeps the primary Agent tab on a manual Session title', () => {
        const decision = decideAgentMetadataUpdate(
            terminal({ id: 'codex-1', provider: 'codex', title: 'Codex' }),
            session({
                displayTitle: 'Manual name',
                lastActivityState: 'running',
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
            terminalTitle: 'Manual name',
            sessionPatch: { displayTitle: 'Manual name', lastActivityState: 'waiting' },
        });
    });

    // A secondary Agent's tab is the only thing naming that conversation, so the Session's manual title is not its own.
    it('leaves a secondary Agent tab on its own conversation name under a manual Session title', () => {
        const decision = decideAgentMetadataUpdate(
            terminal({ id: 'codex-2', provider: 'codex', title: 'Codex' }),
            session({
                displayTitle: 'Manual name',
                lastActivityState: 'running',
                primaryAgentTerminalId: 'codex-1',
                titleMode: 'manual',
            }),
            {
                provider: 'codex',
                available: true,
                observedAt: 0,
                status: 'waiting',
                sessionId: 'agent-session-3',
                title: 'Agent replacement title',
            },
        );

        expect(decision?.terminalTitle).toBe('Agent replacement title');
    });

    it('is a no-op when the snapshot changes nothing observable', () => {
        const primary = terminal({
            id: 'codex-1',
            provider: 'codex',
            title: 'Codex',
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

    it('keeps an exact Agent binding when a metadata probe has no session identity', () => {
        const primary = terminal({
            id: 'codex-1',
            provider: 'codex',
            title: 'Resumed thread',
            agentSessionId: 'resumed-session',
        });

        const decision = decideAgentMetadataUpdate(
            primary,
            session({
                primaryAgentTerminalId: primary.id,
                displayTitle: 'Resumed thread',
                lastActivityState: 'running',
            }),
            {
                provider: 'codex',
                available: false,
                observedAt: 0,
                status: 'running',
            },
        );

        expect(decision).toBeUndefined();
    });

    it('carries an exact Agent binding through an empty probe that still updates activity', () => {
        const primary = terminal({
            id: 'codex-1',
            provider: 'codex',
            agentSessionId: 'resumed-session',
        });

        const decision = decideAgentMetadataUpdate(
            primary,
            session({ primaryAgentTerminalId: primary.id, lastActivityState: 'idle' }),
            {
                provider: 'codex',
                available: false,
                observedAt: 0,
                status: 'running',
            },
        );

        expect(decision).toMatchObject({
            agentSessionId: 'resumed-session',
            sessionPatch: { lastActivityState: 'running' },
        });
    });
});

describe('firstSelectableProject', () => {
    function project(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
        return {
            id: 'project-1',
            rootPath: '/repo',
            displayTitle: 'repo',
            orderIndex: 0,
            createdAt: 0,
            lastOpenedAt: 0,
            ...overrides,
        };
    }

    it('skips worktree Projects the PrimarySidebar never renders', () => {
        const worktree = project({ id: 'project-worktree', ownerProjectId: 'project-owner' });
        const owner = project({ id: 'project-owner' });

        expect(firstSelectableProject([worktree, owner])).toBe(owner);
    });

    it('returns nothing when every remaining Project is a hidden worktree', () => {
        expect(
            firstSelectableProject([project({ ownerProjectId: 'project-owner' })]),
        ).toBeUndefined();
    });

    it('returns the first Project when none is owned', () => {
        const first = project({ id: 'project-first' });

        expect(firstSelectableProject([first, project({ id: 'project-second' })])).toBe(first);
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
            revision: 0,
            workbenchProjectId: 'project-1',
            desiredSecondarySidebarViewContainerId: 'caxri.files',
            paneLayout,
        };

        const next = withTerminalRemovedFromLayout(state, 'terminal-2');

        expect(next).not.toBe(state);
        expect(next.paneLayout).not.toBe(state.paneLayout);
    });
});
