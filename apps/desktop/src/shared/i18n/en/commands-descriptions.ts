/**
 * Palette subtitles for catalog commands, keyed `commands.description.<id>`. The protocol catalog's English
 * `description` stays the search keyword source and the fallback.
 */
export const commandDescriptions = {
    'commands.description.project.create': 'Add a folder as a Project',
    'commands.description.project.delete':
        'Delete the selected Project from Caxri without touching its files',
    'commands.description.project.hide':
        'Hide the selected Project and keep its Sessions; adding the same folder again restores them',
    'commands.description.project.openInEditor':
        'Open the selected Project root in the configured external editor',
    'commands.description.project.customizeIcon':
        'Choose a controlled icon and color for the selected Project',
    'commands.description.projectTransfer.export':
        'Save your Projects and unarchived Sessions to a file you can import into another Caxri',
    'commands.description.projectTransfer.import':
        'Add the Projects and Sessions from an export file, resuming their Agent conversations',
    'commands.description.session.create': 'Create a Session in the selected Project',
    'commands.description.session.rename': 'Rename the selected Session in the Primary Side Bar',
    'commands.description.session.renameWithAi':
        'Suggest a name for the selected Session from its Agent conversation, ready to accept or edit',
    'commands.description.session.delete':
        'Delete the selected Session and its Terminals without touching files on disk',
    'commands.description.session.archive':
        'Move the selected Session out of the sidebar and park its Terminals',
    'commands.description.session.compactWarm':
        'Compact the Agent conversations of Sessions that went idle recently, while compacting them is still cheap',
    'commands.description.session.enterAirplaneMode':
        'Compact idle Agent conversations, then stop every Agent until you resume them, so none retries requests while offline',
    'commands.description.session.detach':
        'Stop the selected Session’s Agent Terminals so another client can resume the same conversation',
    'commands.description.session.resume':
        'Relaunch the selected Session’s detached Agent Terminals and resume their conversations',
    'commands.description.session.openPullRequest':
        'Open the selected Session’s pull request on GitHub in the browser',
    'commands.description.session.selectNext': 'Select the next active Session',
    'commands.description.session.selectPrevious': 'Select the previous active Session',
    'commands.description.session.switchMru':
        'Switch between active Sessions in recently used order',
    'commands.description.session.focusNextAttention':
        'Select the next Session with an event you have not opened yet',
    'commands.description.session.openPinned1': 'Select Session 1 in the Pinned group',
    'commands.description.session.openPinned2': 'Select Session 2 in the Pinned group',
    'commands.description.session.openPinned3': 'Select Session 3 in the Pinned group',
    'commands.description.session.openPinned4': 'Select Session 4 in the Pinned group',
    'commands.description.session.openPinned5': 'Select Session 5 in the Pinned group',
    'commands.description.session.openPinned6': 'Select Session 6 in the Pinned group',
    'commands.description.session.openPinned7': 'Select Session 7 in the Pinned group',
    'commands.description.session.openPinned8': 'Select Session 8 in the Pinned group',
    'commands.description.session.openPinned9': 'Select the last Session in the Pinned group',
    'commands.description.session.navigateBack':
        'Return to the Session you were viewing before this one',
    'commands.description.session.navigateForward':
        'Move forward again through the Sessions you stepped back from',
    'commands.description.session.search':
        'Find Agent conversations in Caxri or only on this machine by title, ID, folder, or message',
    'commands.description.session.openArchived':
        'Open the Archived Sessions manager to restore or delete a parked Session',
    'commands.description.agentActions.open':
        'Search Agent commands and skills for the active Agent Terminal',
    'commands.description.terminal.new': 'Create a Terminal in the current Session',
    'commands.description.terminal.newInSplit':
        'Create a Terminal in a new pane to the right of the active pane',
    'commands.description.terminal.clear': 'Clear the active Terminal view',
    'commands.description.terminal.copy': 'Copy the active Terminal selection to the clipboard',
    'commands.description.terminal.find': 'Search the active Terminal buffer',
    'commands.description.terminal.openDetectedLink':
        'Search and open links detected in the Terminal without using the pointer',
    'commands.description.terminal.previousCommand':
        'Scroll the active Terminal to the previous command boundary',
    'commands.description.terminal.nextCommand':
        'Scroll the active Terminal to the next command boundary',
    'commands.description.workbench.action.terminal.sendSequence':
        'Send configured text directly to the active Terminal',
    'commands.description.terminal.restart':
        'Restart the active Shell, or restart the active Agent and resume its conversation',
    'commands.description.terminal.startNewAgentSession':
        'Restart the active Agent with a new conversation instead of resuming the current one',
    'commands.description.terminal.switchAgentSurface':
        'Reopen the active Agent as a Chat, or a Chat as a Terminal, continuing its conversation',
    'commands.description.terminal.showAgentStatus':
        "Open the active Agent's output speed and its provider's service status",
    'commands.description.agentChat.changeModel':
        "Open the active Chat's model and reasoning effort picker",
    'commands.description.agentChat.changePermissionMode':
        "Open the active Chat's permission level menu",
    'commands.description.agentChat.togglePlanMode': 'Turn plan mode on or off for the active Chat',
    'commands.description.agentChat.openSideChat':
        'Ask a quick question about the active Chat beside it, without adding it to the conversation',
    'commands.description.agentChat.focusWaitingRequest':
        "Move keyboard focus into the waiting popup's question or approval, unfolding it first",
    'commands.description.agentChat.allowRequest':
        "Answer the focused Chat's or the waiting popup's approval with its first button, such as Run or Allow",
    'commands.description.agentChat.denyRequest':
        "Answer the focused Chat's or the waiting popup's approval with Deny, or Keep Planning for a plan",
    'commands.description.terminal.close': 'Close the active Terminal',
    'commands.description.workbench.closeActiveTab': 'Close the active Terminal or file tab',
    'commands.description.workbench.closeOtherTabs':
        'Close the other Terminal or file tabs in the active pane',
    'commands.description.workbench.reopenClosedItem':
        'Reopen the most recently closed file tab or archived Session; repeat to go further back',
    'commands.description.workbench.nextTab': 'Activate the next Terminal or file tab',
    'commands.description.workbench.previousTab': 'Activate the previous Terminal or file tab',
    'commands.description.editor.newUntitledFile':
        'Open an empty untitled editor whose language is detected from what you type; it asks to save before closing',
    'commands.description.editor.save': 'Save the active file',
    'commands.description.editor.sendReferenceToTerminal':
        'Type the active file path and cursor line (`@path#L12`) into the most recently opened Terminal or Agent Chat message',
    'commands.description.editor.addReviewComment': 'Annotate the selected lines in a Git diff',
    'commands.description.editor.openPreview':
        'Show the active Markdown, SVG, CSV, Mermaid, or PDF file as a rendered preview',
    'commands.description.editor.openPreviewToSide':
        'Show the active Markdown, SVG, CSV, Mermaid, or PDF file as a rendered preview beside its source',
    'commands.description.editor.openImportLink':
        'Open the file named by the import specifier under the editor cursor',
    'commands.description.workbench.splitLeft': 'Split the active tab into a new pane to the left',
    'commands.description.workbench.splitRight':
        'Split the active tab into a new pane to the right',
    'commands.description.workbench.splitUp': 'Split the active tab into a new pane above',
    'commands.description.workbench.splitDown': 'Split the active tab into a new pane below',
    'commands.description.workbench.focusPaneLeft':
        'Move keyboard focus to the pane to the left of the current one',
    'commands.description.workbench.focusPaneRight':
        'Move keyboard focus to the pane to the right of the current one',
    'commands.description.workbench.focusPaneUp':
        'Move keyboard focus to the pane above the current one',
    'commands.description.workbench.focusPaneDown':
        'Move keyboard focus to the pane below the current one',
    'commands.description.workbench.moveActiveTerminalToNewSession':
        "Move the active Terminal into a new Session in the Terminal's Project",
    'commands.description.workbench.selectRoot':
        'Point Files, Editor, and Git at another Project root or linked worktree',
    'commands.description.secondarySidebar.showFiles': 'Show Files in the Secondary Side Bar',
    'commands.description.secondarySidebar.searchFiles': 'Search files in the selected Project',
    'commands.description.secondarySidebar.showGit':
        'Show Source Control in the Secondary Side Bar',
    'commands.description.secondarySidebar.showStatus':
        'Show Project Status in the Secondary Side Bar',
    'commands.description.secondarySidebar.toggle': 'Show or hide the Secondary Side Bar',
    'commands.description.panel.showLogs': 'Show Logs in the Panel',
    'commands.description.panel.showInfo': 'Show Info in the Panel',
    'commands.description.panel.toggle': 'Show or hide the Panel',
    'commands.description.primarySidebar.toggle': 'Show or hide the Primary Side Bar',
    'commands.description.primarySidebar.toggleActivity':
        'Swap the Primary Side Bar between the Project tree and every Project’s Agent Sessions grouped by what needs attention',
    'commands.description.primarySidebar.focus':
        'Move keyboard focus into the Primary Side Bar, revealing it first when hidden',
    'commands.description.view.zoomIn': 'Enlarge the whole interface by one zoom step',
    'commands.description.view.toggleZenMode':
        'Hide the side bars, Panel, tab bars, and status bar so only the current Chat or Terminal remains',
    'commands.description.view.zoomOut': 'Shrink the whole interface by one zoom step',
    'commands.description.view.resetZoom': 'Return the interface to its original size',
    'commands.description.usage.open':
        'Show token usage, estimated cost, and delivery stats for Caxri Sessions',
    'commands.description.environment.open':
        'Show the current public exit, system time zone, and monitored Mihomo routes',
    'commands.description.benchmark.open':
        'Run one prompt across several Agents and models and compare quality, time, tokens, and cost',
    'commands.description.settings.open': 'Open Caxri Settings',
    'commands.description.settings.openSource': 'Open settings.jsonc in the Caxri source editor',
    'commands.description.settings.openKeybindings': 'Edit Caxri keyboard shortcuts',
    'commands.description.settings.openNotifications':
        'Manage notification preferences and restore muted reminders',
    'commands.description.settings.manageTrustedDomains':
        'Review which external-link origins Caxri opens without confirmation',
    'commands.description.updates.check': 'Check for a newer Caxri release',
    'commands.description.shellCommand.install':
        'Link the bundled caxri CLI into /usr/local/bin so any terminal can run it',
    'commands.description.shellCommand.uninstall':
        'Remove the caxri link that points into a Caxri app bundle',
    'commands.description.pathBrowser.open': 'Browse the selected Project and open a file',
    'commands.description.commandPalette.open': 'Search and run Caxri commands',
    'commands.description.caxriBot.open':
        'Open the cross-Project Agent board beside Caxri Bot’s Agent',
    'commands.description.caxriBot.stop':
        'Stop Caxri Bot running in the background; opening it again resumes the same conversation',
    'commands.description.caxriBot.handOver':
        'Pick Sessions, or Agent conversations started outside Caxri, for Caxri Bot to take over',
    'commands.description.caxriBot.takeBack':
        'End Caxri Bot’s management of the selected Session; its Agents keep running',
    'commands.description.help.showKeyboardShortcuts':
        'Show every keyboard shortcut, grouped by category',
    'commands.description.help.openDocumentation':
        'Open the Caxri getting started guide in your browser',
    'commands.description.help.openReleaseNotes': 'See what changed in each Caxri release',
    'commands.description.help.reportIssue': 'Open the Caxri issue tracker in your browser',
    'commands.description.help.revealLogs': 'Show the Caxri log folder in Finder',
    'commands.description.processExplorer.open': 'Inspect Caxri process resource usage',
    'commands.description.developer.toggleScreencastMode':
        'Show clicks and Caxri shortcuts for external screen recording',
    'commands.description.developer.togglePerformanceMonitor':
        'Show or hide the draggable frame rate and resource monitor',
    'commands.description.developer.openPerformanceMonitorWindow':
        'Open the performance monitor in its own window, which survives reloading',
    'commands.description.developer.reportBug':
        'Preview and send a privacy-safe local bug report to a running Agent',
    'commands.description.diagnostics.export': 'Export a privacy-safe diagnostics bundle',
    'commands.description.sshHost.connect':
        'Open a window whose Projects, Terminals, and Agents run on an SSH Host',
    'commands.description.sshHost.reconnect': "Reconnect this window to its SSH Host's Server",
    'commands.description.sshHost.stopServer':
        'Stop the Server on this SSH Host, ending every Terminal and Agent running there',
    'commands.description.git.switchBranch':
        "Check out another branch in the selected Session's repository",
    'commands.description.git.goToNextReviewComment':
        'Jump to the next review comment anchored in the active Git diff tab',
    'commands.description.git.goToPreviousReviewComment':
        'Jump to the previous review comment anchored in the active Git diff tab',
    'commands.description.git.showPendingReviewComments':
        'Open the repository with pending review comments and reveal them',
} as const;
