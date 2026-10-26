import type { CommandContext } from './registry';

/**
 * A command context whose every action records its name (and first argument) instead of acting, with every availability
 * predicate true, so a test can assert which handler a command reached.
 */
export function recordingContext(): { calls: string[]; context: CommandContext } {
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
            agentChatWaiting: {
                canFocus: () => true,
                focus: record('agentChatWaiting.focus'),
            },
            agentChatApproval: {
                canAnswer: () => true,
                answer: record('agentChatApproval.answer'),
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
                compactWarm: record('session.compactWarm'),
                canNavigateHistory: () => true,
                create: record('session.create'),
                focusNextAttention: record('session.focusNextAttention'),
                deleteSelected: record('session.delete'),
                detachSelected: record('session.detach'),
                navigateHistory: record('session.navigateHistory'),
                openArchived: record('session.openArchived'),
                openPinned: record('session.openPinned'),
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
                canCloseOtherTabs: () => true,
                closeOtherTabs: record('workbench.closeOtherTabs'),
                reopenClosedItem: record('workbench.reopenClosedItem'),
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
                newUntitledFile: record('editor.newUntitledFile'),
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
                openPerformanceMonitorWindow: record('developer.openPerformanceMonitorWindow'),
                reportBug: record('developer.reportBug'),
                togglePerformanceMonitor: record('developer.togglePerformanceMonitor'),
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
