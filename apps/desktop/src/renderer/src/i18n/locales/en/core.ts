/**
 * Shared chrome outside `features/`: the crash screen, shared components, `lib/` helpers, and the notices the stores
 * raise outside React.
 */
export const core = {
    // components/error-boundary.tsx and the window entries
    'core.errorBoundary.title': 'Something went wrong',
    'core.errorBoundary.description':
        'Caxri ran into an unexpected error. Reloading will bring back your projects and sessions.',
    'core.errorBoundary.technicalDetails': 'Technical details',
    'core.errorBoundary.copyDetails': 'Copy details',
    'core.errorBoundary.reloadWithoutSession': 'Reload without this Session',
    'core.errorBoundary.caxriBot.title': 'Caxri Bot stopped rendering',
    'core.errorBoundary.caxriBot.description':
        'Reload Caxri Bot to reconnect to its Terminal. Caxri Bot keeps running meanwhile.',
    'core.errorBoundary.caxriBot.reload': 'Reload Caxri Bot',
    'core.errorBoundary.benchmark.title': 'Benchmark stopped rendering',
    'core.errorBoundary.benchmark.description':
        'Reload Benchmark to show your runs again. Runs already started keep going meanwhile.',
    'core.errorBoundary.benchmark.reload': 'Reload Benchmark',
    'core.errorBoundary.performanceMonitor.title': 'Performance Monitor stopped rendering',
    'core.errorBoundary.performanceMonitor.description':
        'Reload the Performance Monitor to resume live readings.',
    'core.errorBoundary.performanceMonitor.reload': 'Reload Performance Monitor',
    'core.errorBoundary.processExplorer.title': 'Process Explorer stopped rendering',
    'core.errorBoundary.processExplorer.description':
        'Reload Process Explorer to resume live diagnostics.',
    'core.errorBoundary.processExplorer.reload': 'Reload Process Explorer',

    // components/copy-feedback.ts and the markdown copy buttons
    'core.copy.failed': 'Copy failed',
    'core.copy.code': 'Copy code',
    'core.copy.table': 'Copy table',
    'core.copy.quote': 'Copy quote',
    'core.copy.diagramSource': 'Copy diagram source',

    // components/markdown/block-fullscreen-dialog.tsx
    'core.block.fullscreen': 'View Full Screen',
    'core.block.table': 'Table',
    'core.block.diagram': 'Diagram',

    // components/find-bar.tsx
    'core.findBar.placeholder': 'Find',
    'core.findBar.previousMatch': 'Previous Match',
    'core.findBar.nextMatch': 'Next Match',
    'core.findBar.close': 'Close Find',

    // components/report-card.tsx
    'core.reportCard.notMeasured': 'Not measured',

    // components/markdown
    'core.codeView.enableWordWrap': 'Enable word wrap',
    'core.codeView.disableWordWrap': 'Disable word wrap',
    'core.codeView.plainText': 'Text',
    'core.codeView.runInTerminal': 'Run in Terminal',
    'core.markdown.openFile': 'Open {{file}}',
    'core.markdown.taskDone': 'Done: ',
    'core.markdown.taskTodo': 'To do: ',

    // components/ui
    'core.spinner.loading': 'Loading',
    'core.command.suggestions': 'Suggestions',

    // lib/diff-stat-label.ts
    'core.diffStat.labelOne': '{{additions}} line added, {{deletions}} removed',
    'core.diffStat.labelOther': '{{additions}} lines added, {{deletions}} removed',

    // lib/git-decorations.ts
    'core.gitDecoration.description': 'Git: {{kind}}.',
    'core.gitDecoration.kind.added': 'added',
    'core.gitDecoration.kind.conflicted': 'conflicted',
    'core.gitDecoration.kind.deleted': 'deleted',
    'core.gitDecoration.kind.modified': 'modified',
    'core.gitDecoration.kind.renamed': 'renamed',
    'core.gitDecoration.kind.untracked': 'untracked',
    'core.gitDecoration.childRepo.nested': 'Nested Git repository.',
    'core.gitDecoration.childRepo.submodule': 'Git submodule.',

    // lib/external-link.ts
    'core.externalLink.unsupportedProtocol': 'Only HTTP and HTTPS links can be opened',
    'core.externalLink.credentialsNotAllowed': 'External links cannot include credentials',
    'core.externalLink.invalid': 'External link is invalid',
    'core.externalLink.openFailed': 'External link could not be opened',

    // lib/document-read-failure.ts
    'core.documentRead.failed': "Couldn't open this file",
    'core.documentRead.interrupted': 'Opening this file was interrupted.',

    // lib/context-menu.ts, hooks/use-context-menu.ts
    'core.contextMenu.showFailed': 'Unable to show the menu',

    // lib/copy-file-path.ts, lib/desktop-file-actions.ts
    'core.files.copyPathFailed': 'Unable to copy path',
    'core.files.pathOutsideProject': 'Path is outside the selected Project',
    'core.files.relativePathCopied': 'Relative path copied',
    'core.files.pathCopied': 'Path copied',
    'core.files.nameCopied': 'Name copied',
    'core.files.noSessionSelected': 'No Session is selected',
    'core.files.revealFailed': 'Unable to reveal item in Finder',
    'core.files.openWithDefaultAppFailed': 'Unable to open item with the default application',

    // stores/workbench.ts, stores/workbench-snapshot-failure.ts
    'core.workbench.layoutSaveFailed': 'Session layout could not be saved',
    'core.workbench.profileTakenOver':
        'Another Caxri window took over this profile. Continue in the other window.',
    'core.workbench.snapshotLoadFailed': 'Unable to load Projects and Sessions from the Server',
    'core.workbench.snapshotRefreshFailed':
        'Unable to refresh Projects and Sessions from the Server',

    // stores/workbench-root-notice.ts
    'core.configurationErrors.multiple':
        '{{count}} configuration files have errors and their defaults are in use. First: {{first}}',
    'core.workbenchRoot.fallback':
        'The active worktree is no longer available. Returned to {{title}}.',
    'core.workbenchRoot.followedNamed': 'Switched to worktree "{{title}}" — an Agent moved there.',
    'core.workbenchRoot.followed': 'Switched to another worktree — an Agent moved there.',
    'core.workbenchRoot.undoNamed': 'Undo the switch to worktree {{title}}',
    'core.workbenchRoot.undo': 'Undo the switch to another worktree',
    'core.workbenchRoot.undoFailed': 'Unable to return to the previous Workbench Root',

    // stores/automatic-naming-notice.ts
    'core.automaticNaming.sandboxBoundaryConflict':
        '{{subject}}: Automatic naming is blocked by the Project sandbox boundary. Choose a more specific Project folder and restart the Agent.',
    'core.automaticNaming.sandboxUnavailable':
        '{{subject}}: Automatic naming needs bubblewrap (bwrap) on this machine. Install it, then restart the Agent.',
    'core.automaticNaming.unverifiedPaths':
        '{{subject}}: Automatic naming is unavailable because its sandbox paths could not be verified. Restart the Agent after correcting the paths.',

    // stores/workbench-event-notifications.ts
    'core.agentNotification.waiting': '{{title}} is waiting for your input.',
    'core.agentNotification.completed': '{{title}} completed a turn.',
    'core.projectStatusAlert.checkFailed': 'CI failed: {{name}}',
    'core.projectStatusAlert.deploymentFailed': '{{name}} deployment failed',

    // commands/execute.ts
    'core.commands.usageNeedsProject': 'Add a Project to open Usage',
    'core.commands.openBenchmarkFailed': 'Unable to open Benchmark',
    'core.commands.openCaxriBotFailed': 'Unable to open Caxri Bot',
    'core.commands.diagnosticsExportFailed': 'Diagnostics export failed',
    'core.commands.diagnosticsExported': 'Diagnostics exported to {{path}}',
    'core.projectTransfer.exportFailed': 'Projects and Sessions export failed',
    'core.projectTransfer.exported':
        'Exported {{projects}} Projects and {{sessions}} Sessions to {{path}}',
    'core.projectTransfer.importFailed': 'Projects and Sessions import failed',
    'core.projectTransfer.imported': 'Imported {{projects}} Projects and {{sessions}} Sessions',
    'core.projectTransfer.skippedMissing': 'Skipped {{path}}: the folder no longer exists',
    'core.projectTransfer.skippedExists': 'Skipped {{path}}: already a Project',
    'core.projectTransfer.worktreeMissing':
        'Worktree {{path}} no longer exists; its Session opens in the Project folder',
    'core.projectTransfer.moreSkipped': 'And {{count}} more',
    'core.commands.revealExportFailed': 'Unable to show the diagnostics file in Finder',
    'core.commands.revealLogsFailed': 'Unable to show the log folder in Finder',

    // lib/usage-format.ts
    'core.usageFormat.lessThanMinute': '<1m',
    'core.usageFormat.minutes': '{{minutes}}m',
    'core.usageFormat.hours': '{{hours}}h',
    'core.usageFormat.hoursMinutes': '{{hours}}h {{minutes}}m',
    'core.usageFormat.window.weekly': 'Weekly',
    'core.usageFormat.window.days': '{{count}}-day',
    'core.usageFormat.window.hours': '{{count}}-hour',
    'core.usageFormat.window.minutes': '{{count}}-minute',
    'core.usageFormat.shortWindow.weekly': 'wk',
    'core.usageFormat.shortWindow.days': '{{count}}d',
    'core.usageFormat.shortWindow.hours': '{{count}}h',
    'core.usageFormat.shortWindow.minutes': '{{count}}m',
    'core.usageFormat.resetsNow': 'resets now',
    'core.usageFormat.resetsInDays': 'resets in {{days}}d {{hours}}h',
    'core.usageFormat.resetsIn': 'resets in {{duration}}',
} as const;
