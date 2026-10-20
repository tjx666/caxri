import type { BootstrapState, CommandId, PaneLayout, ProcessState } from '@caxri/protocol';
import {
    activePane,
    commandDefinitions as sharedCommandDefinitions,
    createPaneLayout,
    listPanes,
    MAX_PANE_LAYOUT_PANES,
    openResource,
    splitTabIntoPane,
} from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useCommanderHandoverStore } from '../features/agent-commander/commander-handover-store';
import { useEnvironmentStore } from '../stores/environment';
import { useWorkbenchStore } from '../stores/workbench';
import { commandDefinitions as registeredCommandDefinitions } from './definitions';
import type { CommandContext } from './execute';
import { executeCommand, isCommandAvailable } from './execute';

/**
 * The suite runs under Vitest's `node` environment (no jsdom, see `vitest.config.ts`), so `Element` and a real
 * `document` do not exist; `isEditableEventTarget` itself is exercised elsewhere by the keyboard-shortcut listener it
 * backs. Here it is mocked so `runCommand`'s gate can be driven by a plain boolean instead of a real DOM focus target.
 */
vi.mock('../lib/keybindings', () => ({ isEditableEventTarget: vi.fn() }));

/**
 * `execute.ts` imports `git-review-navigation-commands.ts`, which reaches `git-review-comment-binding.ts` for its
 * mounted-editor registry; that module imports Monaco, which needs a real `window` unavailable under this suite's
 * `node` environment. This test drives `context.git.*` through the local `record`-based stand-ins below rather than the
 * real navigation commands, so the binding registry itself is stubbed out instead of loaded.
 */
vi.mock('../features/editor/git-review-comment-binding', () => ({
    listBoundGitReviewCommentEditors: () => new Set(),
}));
const catalogOwnedSharedIds = new Set<CommandId>(
    sharedCommandDefinitions
        .filter(({ execution }) => execution === 'viewCatalog')
        .map(({ id }) => id),
);

/**
 * Puts a layout where the default command context reads it from, for the availability predicates that resolve their
 * target from the Session rather than from the caller.
 */
function seedPaneLayout(paneLayout: PaneLayout): void {
    useWorkbenchStore.setState({
        bootstrap: {
            selectedSessionId: 'session-1',
            sessions: [{ id: 'session-1', projectId: 'project-1' }],
            sessionStates: [{ sessionId: 'session-1', paneLayout }],
        } as unknown as BootstrapState,
        attachEpoch: 0,
    });
}

/**
 * Seeds the default command context with a content-free Agent Terminal whose outer shell remains alive independently
 * from its Agent child.
 */
function seedAgentTerminal(lastAgentProcessState: ProcessState | undefined): void {
    const paneLayout = createPaneLayout(
        { kind: 'terminal', terminalId: 'terminal-1' },
        () => 'tab-1',
    );
    useWorkbenchStore.setState({
        bootstrap: {
            selectedSessionId: 'session-1',
            sessions: [{ id: 'session-1', projectId: 'project-1' }],
            sessionStates: [{ sessionId: 'session-1', paneLayout }],
            terminals: [
                {
                    id: 'terminal-1',
                    sessionId: 'session-1',
                    kind: 'codex',
                    provider: 'codex',
                    lastProcessState: 'running',
                    lastAgentProcessState,
                },
            ],
        } as unknown as BootstrapState,
        attachEpoch: 0,
    });
}

function recordingContext(): { calls: string[]; context: CommandContext } {
    const calls: string[] = [];
    const record =
        (name: string) =>
        (...arguments_: unknown[]): void => {
            calls.push(arguments_.length > 0 ? `${name}(${String(arguments_[0])})` : name);
        };
    return {
        calls,
        context: {
            agentActions: {
                canOpen: () => true,
                open: record('agentActions.open'),
            },
            agentChat: {
                canRun: () => true,
                run: record('agentChat.run'),
            },
            project: {
                create: record('project.create'),
                customizeIcon: record('project.customizeIcon'),
                hideSelected: record('project.hide'),
                openInExternalEditor: record('project.openInEditor'),
                remove: record('project.remove'),
            },
            session: {
                archiveSelected: record('session.archive'),
                closeTab: record('session.closeTab'),
                compactWarm: record('session.compactWarm'),
                canNavigateHistory: () => true,
                create: record('session.create'),
                focusNextAttention: record('session.focusNextAttention'),
                deleteSelected: record('session.delete'),
                detachSelected: record('session.detach'),
                navigateHistory: record('session.navigateHistory'),
                openArchived: record('session.openArchived'),
                openTab: record('session.openTab'),
                openPullRequestSelected: record('session.openPullRequest'),
                renameSelected: record('session.rename'),
                renameSelectedWithAi: record('session.renameWithAi'),
                resumeSelected: record('session.resume'),
                selectAdjacent: record('session.selectAdjacent'),
                switchMru: record('session.switchMru'),
                takeBackSelectedFromCommander: record('session.takeBackFromCommander'),
            },
            terminal: {
                create: record('terminal.create'),
                createInSplit: record('terminal.createInSplit'),
                clearActive: record('terminal.clear'),
                copySelection: record('terminal.copySelection'),
                findActive: record('terminal.find'),
                openDetectedLink: record('terminal.openDetectedLink'),
                hasActive: () => true,
                hasSelection: () => true,
                navigateCommand: record('terminal.navigateCommand'),
                sendSequence: record('terminal.sendSequence'),
                restartActive: record('terminal.restart'),
                startNewAgentSession: record('terminal.startNewAgentSession'),
                canSwitchActiveSurface: () => true,
                switchActiveSurface: record('terminal.switchAgentSurface'),
                isActiveAgent: () => true,
                showActiveAgentStatus: record('terminal.showAgentStatus'),
                closeActive: record('terminal.close'),
            },
            workbench: {
                closeActiveTab: record('workbench.closeActiveTab'),
                cycleTab: record('workbench.cycleTab'),
                canSplitActive: () => true,
                splitActive: record('workbench.splitActive'),
                canFocusPaneInDirection: () => true,
                focusPaneInDirection: record('workbench.focusPaneInDirection'),
                canMoveActiveTerminalToNewSession: () => true,
                moveActiveTerminalToNewSession: record('workbench.moveActiveTerminalToNewSession'),
                canSelectRoot: () => true,
                selectRoot: record('workbench.selectRoot'),
            },
            editor: {
                saveActive: record('editor.save'),
                canSendReferenceToTerminal: () => true,
                sendReferenceToTerminal: record('editor.sendReferenceToTerminal'),
                canAddReviewComment: () => true,
                addReviewComment: record('editor.addReviewComment'),
                canOpenPreview: () => true,
                openPreview: record('editor.openPreview'),
                openPreviewToSide: record('editor.openPreviewToSide'),
                canOpenImportLink: () => true,
                openImportLink: record('editor.openImportLink'),
            },
            secondarySidebar: {
                activateViewContainer: record('secondarySidebar.activateViewContainer'),
                toggle: record('secondarySidebar.toggle'),
            },
            panel: {
                activateViewContainer: record('panel.activateViewContainer'),
                toggle: record('panel.toggle'),
            },
            primarySidebar: {
                focus: record('primarySidebar.focus'),
                toggle: record('primarySidebar.toggle'),
                toggleActivityMode: record('primarySidebar.toggleActivityMode'),
            },
            git: {
                canSwitchBranch: () => true,
                switchBranch: record('git.switchBranch'),
                canGoToReviewComment: () => true,
                goToNextReviewComment: record('git.goToNextReviewComment'),
                goToPreviousReviewComment: record('git.goToPreviousReviewComment'),
                showPendingReviewComments: record('git.showPendingReviewComments'),
            },
            dialogs: {
                openSettings: record('dialogs.openSettings'),
                openPalette: record('dialogs.openPalette'),
                openUsage: record('dialogs.openUsage'),
                openPathBrowser: record('dialogs.openPathBrowser'),
                openProjectSearch: record('dialogs.openProjectSearch'),
                openSessionSearch: record('dialogs.openSessionSearch'),
                openKeyboardShortcuts: record('dialogs.openKeyboardShortcuts'),
                openCommanderHandover: record('dialogs.openCommanderHandover'),
            },
            windows: {
                openAgentCommander: record('windows.openAgentCommander'),
                openBenchmark: record('windows.openBenchmark'),
                stopAgentCommander: record('windows.stopAgentCommander'),
                openProcessExplorer: record('windows.openProcessExplorer'),
                zoom: record('windows.zoom'),
            },
            developer: {
                reportBug: record('developer.reportBug'),
                toggleScreencastMode: record('developer.toggleScreencastMode'),
            },
            diagnostics: { export: record('diagnostics.export') },
            updates: { check: record('updates.check') },
            shellCommand: {
                install: record('shellCommand.install'),
                uninstall: record('shellCommand.uninstall'),
            },
            sshHost: {
                isLocalOnlyAvailable: () => true,
                isSshHost: () => true,
                connect: record('sshHost.connect'),
                reconnect: record('sshHost.reconnect'),
                stopServer: record('sshHost.stopServer'),
            },
        },
    };
}

describe('executeCommand', () => {
    // `seedPaneLayout` writes a module-level store, so a test that seeds one must not leave it standing for the next.
    afterEach(() => {
        useWorkbenchStore.setState({ bootstrap: undefined, attachEpoch: 0 });
    });

    it('dispatches every command in the shared catalog', () => {
        for (const definition of sharedCommandDefinitions) {
            if (catalogOwnedSharedIds.has(definition.id)) continue;
            const { calls, context } = recordingContext();
            executeCommand(
                definition.id,
                definition.requiresArguments ? { text: 'configured argument' } : undefined,
                context,
            );
            expect(calls, `no handler ran for ${definition.id}`).toHaveLength(1);
        }
    });

    it('registers exactly the ids the shared catalog declares, in both directions', () => {
        const sharedIds = new Set(sharedCommandDefinitions.map((definition) => definition.id));
        const registeredIds = new Set(
            registeredCommandDefinitions.map((definition) => definition.id),
        );

        for (const id of sharedIds)
            if (!catalogOwnedSharedIds.has(id))
                expect(registeredIds, `registry is missing ${id}`).toContain(id);
        for (const id of catalogOwnedSharedIds)
            expect(
                registeredIds,
                `catalog-owned command leaked into the builtin registry: ${id}`,
            ).not.toContain(id);
        for (const id of registeredIds)
            expect(sharedIds, `shared catalog is missing ${id}`).toContain(id);
    });

    it('runs Agent Actions only when the active Terminal is a running Agent', () => {
        const { calls, context } = recordingContext();
        context.agentActions.canOpen = () => false;
        executeCommand('agentActions.open', undefined, context);
        expect(calls).toEqual([]);

        context.agentActions.canOpen = () => true;
        executeCommand('agentActions.open', undefined, context);
        expect(calls).toEqual(['agentActions.open']);
    });

    it('runs a Chat composer command only while the active Chat offers its control', () => {
        const { calls, context } = recordingContext();
        context.agentChat.canRun = (command) => command === 'togglePlanMode';

        executeCommand('agentChat.changeModel', undefined, context);
        executeCommand('agentChat.changePermissionMode', undefined, context);
        executeCommand('agentChat.togglePlanMode', undefined, context);

        expect(calls).toEqual(['agentChat.run(togglePlanMode)']);
    });

    it('offers local-only commands only in a local window and SSH Host commands only in an SSH Host window', () => {
        const localOnly = [
            'agentCommander.handOver',
            'agentCommander.open',
            'agentCommander.stop',
            'agentCommander.takeBack',
            'developer.reportBug',
            'diagnostics.export',
            'processExplorer.open',
            'project.openInEditor',
            'shellCommand.install',
            'shellCommand.uninstall',
        ] as const;
        const sshHostOnly = ['sshHost.reconnect', 'sshHost.stopServer'] as const;
        const local = recordingContext();
        local.context.sshHost.isSshHost = () => false;
        const remote = recordingContext();
        remote.context.sshHost.isLocalOnlyAvailable = () => false;

        for (const id of [
            ...localOnly,
            ...sshHostOnly,
            'sshHost.connect',
            'pathBrowser.open',
        ] as const) {
            executeCommand(id, undefined, local.context);
            executeCommand(id, undefined, remote.context);
        }

        expect(local.calls).toHaveLength(localOnly.length + 2);
        expect(local.calls).not.toContain('sshHost.reconnect');
        expect(remote.calls).toEqual([
            'sshHost.reconnect',
            'sshHost.stopServer',
            'sshHost.connect',
            'dialogs.openPathBrowser',
        ]);
        // Each of these palette predicates holds only in a local window; see `commanderPaletteWhenContext`.
        const localWindowPredicates = [
            'localMachine',
            'commanderHandOverAvailable',
            'commanderTakeBackAvailable',
        ];
        for (const id of localOnly)
            expect(
                localWindowPredicates,
                `${id} must stay out of an SSH Host window's palette`,
            ).toContain(sharedCommandDefinitions.find((definition) => definition.id === id)?.when);
    });

    it('opens the hand-over picker with the selected Session checked', () => {
        useEnvironmentStore.setState({ state: { kind: 'local' } });
        useWorkbenchStore.setState({
            bootstrap: {
                selectedSessionId: 'session-1',
                sessions: [{ id: 'session-1', projectId: 'project-1' }],
                sessionStates: [],
            } as unknown as BootstrapState,
            attachEpoch: 0,
        });

        executeCommand('agentCommander.handOver');

        expect(useCommanderHandoverStore.getState().request?.sessionIds).toEqual(['session-1']);
        useCommanderHandoverStore.setState({ request: undefined });
        useEnvironmentStore.setState({ state: undefined });
    });

    it('passes a Project row target through the delete command', () => {
        const { calls, context } = recordingContext();

        executeCommand('project.delete', { projectId: 'project-right-clicked' }, context);

        expect(calls).toEqual(['project.remove(project-right-clicked)']);
    });

    it.each([
        { expected: true, lastAgentProcessState: 'running' as const },
        { expected: false, lastAgentProcessState: 'stopped' as const },
        { expected: false, lastAgentProcessState: 'dead' as const },
        { expected: false, lastAgentProcessState: undefined },
    ])(
        'exposes Agent Actions=$expected when the Agent child state is $lastAgentProcessState',
        ({ expected, lastAgentProcessState }) => {
            seedAgentTerminal(lastAgentProcessState);

            expect(isCommandAvailable('agentActions.open')).toBe(expected);
        },
    );

    it('keeps registry titles and categories in sync with the shared catalog', () => {
        for (const definition of registeredCommandDefinitions) {
            const shared = sharedCommandDefinitions.find((item) => item.id === definition.id);
            expect(shared, `shared catalog is missing ${definition.id}`).toBeDefined();
            expect(definition.title).toBe(shared?.title);
            expect(definition.category).toBe(shared?.category);
        }
    });

    it('maps the Session navigation commands to opposite directions', () => {
        const { calls, context } = recordingContext();
        executeCommand('session.selectNext', undefined, context);
        executeCommand('session.selectPrevious', undefined, context);

        expect(calls).toEqual(['session.selectAdjacent(1)', 'session.selectAdjacent(-1)']);
    });

    it('maps each numbered Open Session command to its position, with the ninth meaning the last', () => {
        const { calls, context } = recordingContext();
        executeCommand('session.openTab1', undefined, context);
        executeCommand('session.openTab5', undefined, context);
        executeCommand('session.openTab9', undefined, context);
        executeCommand('session.closeTab', undefined, context);

        expect(calls).toEqual([
            'session.openTab(1)',
            'session.openTab(5)',
            'session.openTab(9)',
            'session.closeTab',
        ]);
    });

    it('passes the shortcut lifecycle metadata to Session MRU switching', () => {
        const { context } = recordingContext();
        const switchMru = vi.fn();
        context.session.switchMru = switchMru;
        executeCommand(
            'session.switchMru',
            {
                shortcut: {
                    direction: -1,
                    heldModifiers: ['Control', 'Alt'],
                    triggerCode: 'Tab',
                },
            },
            context,
        );

        expect(switchMru).toHaveBeenCalledWith({
            direction: -1,
            heldModifiers: ['Control', 'Alt'],
            triggerCode: 'Tab',
        });
    });

    it.each(['terminal.clear', 'terminal.find'] as const)(
        'keeps %s contextual so Monaco can own the same shortcut in an editor',
        (command) => {
            const { calls, context } = recordingContext();
            context.terminal.hasActive = () => false;

            expect(isCommandAvailable(command, context)).toBe(false);
            executeCommand(command, undefined, context);

            expect(calls).toEqual([]);
        },
    );

    /**
     * `terminal.copy` binds `Cmd+C`. Without a Terminal selection the command must decline so the chord falls through
     * to the native copy an input or Monaco would otherwise handle.
     */
    it('keeps Terminal Copy contextual on the presence of a selection', () => {
        const { calls, context } = recordingContext();
        context.terminal.hasSelection = () => false;

        expect(isCommandAvailable('terminal.copy', context)).toBe(false);
        executeCommand('terminal.copy', undefined, context);

        expect(calls).toEqual([]);
    });

    it('maps the tab cycling commands to opposite directions', () => {
        const { calls, context } = recordingContext();
        executeCommand('workbench.nextTab', undefined, context);
        executeCommand('workbench.previousTab', undefined, context);

        expect(calls).toEqual(['workbench.cycleTab(1)', 'workbench.cycleTab(-1)']);
    });

    it('sends an exact configured control sequence to the active Terminal', () => {
        const { context } = recordingContext();
        const sendSequence = vi.fn();
        context.terminal.sendSequence = sendSequence;

        executeCommand('workbench.action.terminal.sendSequence', { text: '\u{1B}[1;3B' }, context);

        expect(sendSequence).toHaveBeenCalledWith('\u{1B}[1;3B');
    });

    it('normalizes configured newlines to Return before sending a Terminal sequence', () => {
        const { context } = recordingContext();
        const sendSequence = vi.fn();
        context.terminal.sendSequence = sendSequence;

        executeCommand(
            'workbench.action.terminal.sendSequence',
            { text: '\t\nfirst\r\nsecond' },
            context,
        );

        expect(sendSequence).toHaveBeenCalledWith('\t\rfirst\rsecond');
    });

    it('maps each split command to the side its new pane takes', () => {
        const { calls, context } = recordingContext();
        executeCommand('workbench.splitLeft', undefined, context);
        executeCommand('workbench.splitRight', undefined, context);
        executeCommand('workbench.splitUp', undefined, context);
        executeCommand('workbench.splitDown', undefined, context);

        expect(calls).toEqual([
            'workbench.splitActive(left)',
            'workbench.splitActive(right)',
            'workbench.splitActive(up)',
            'workbench.splitActive(down)',
        ]);
    });

    it('maps the split-terminal command to creating a fresh Terminal in a new pane', () => {
        const { calls, context } = recordingContext();

        executeCommand('terminal.newInSplit', undefined, context);

        expect(calls).toEqual(['terminal.createInSplit']);
    });

    /**
     * The active pane must hold more than one tab; otherwise the split commands are no-ops so the palette and native
     * menu never invoke `splitActive` against a pane that would be left empty.
     */
    it('keeps split commands contextual on a pane that can actually be split', () => {
        const { calls, context } = recordingContext();
        context.workbench.canSplitActive = () => false;

        expect(isCommandAvailable('workbench.splitLeft', context)).toBe(false);
        executeCommand('workbench.splitLeft', undefined, context);

        expect(calls).toEqual([]);
    });

    /**
     * The Context Menu and the reducer share `paneSplitBlockedReason`; the Command Palette and the native menu reach
     * `splitActive` through `canSplitActive` instead, and used to gate on tab count alone. At the pane ceiling that
     * left the command looking available while the write path silently no-opped.
     */
    it('withdraws the split commands once the layout is at its pane ceiling', () => {
        const id = (() => {
            let next = 0;
            return () => `id-${++next}`;
        })();
        let layout = createPaneLayout({ kind: 'file', path: 'a.ts' }, id);
        while (listPanes(layout).length < MAX_PANE_LAYOUT_PANES) {
            layout = openResource(
                layout,
                { kind: 'file', path: `p${listPanes(layout).length}.ts` },
                {},
                id,
            );
            const [head] = activePane(layout).tabs;
            layout = splitTabIntoPane(layout, head.id, activePane(layout).id, 'right', id);
        }
        // A second tab in the active pane, so only the ceiling (never the tab count) can block the split.
        layout = openResource(layout, { kind: 'file', path: 'extra.ts' }, {}, id);
        expect(activePane(layout).tabs.length).toBeGreaterThan(1);

        seedPaneLayout(layout);
        expect(isCommandAvailable('workbench.splitRight')).toBe(false);
    });

    it('deep-links the Settings source and Trusted Domains commands', () => {
        const { calls, context } = recordingContext();

        executeCommand('settings.open', undefined, context);
        executeCommand('settings.openSource', undefined, context);
        executeCommand('settings.manageTrustedDomains', undefined, context);

        expect(calls).toEqual([
            'dialogs.openSettings',
            'dialogs.openSettings(source)',
            'dialogs.openSettings(trusted-domains)',
        ]);
    });

    it('opens the Keyboard Shortcuts cheatsheet in an SSH Host window too', () => {
        const { calls, context } = recordingContext();
        context.sshHost.isLocalOnlyAvailable = () => false;

        executeCommand('help.showKeyboardShortcuts', undefined, context);

        expect(calls).toEqual(['dialogs.openKeyboardShortcuts']);
    });

    it('delegates an unknown local command without throwing', () => {
        const { calls, context } = recordingContext();

        expect(() => executeCommand('does.notExist', undefined, context)).not.toThrow();
        expect(calls).toEqual([]);
    });
});
