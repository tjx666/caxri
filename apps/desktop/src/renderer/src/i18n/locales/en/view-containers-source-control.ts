/**
 * Source Control view: panel states, header, provider and group rows, branch sync confirmation, and history.
 */
export const viewContainersSourceControl = {
    'viewContainers.sourceControl.title': 'Source Control',
    'viewContainers.sourceControl.refresh': 'Refresh Source Control',
    'viewContainers.sourceControl.refreshing': 'Refreshing Source Control',
    'viewContainers.sourceControl.noSession': 'No Session selected',
    'viewContainers.sourceControl.noSessionHint': 'Pick a Session to inspect its Git state.',
    'viewContainers.sourceControl.loading': 'Loading Git status…',
    'viewContainers.sourceControl.noRepository': 'No Git repository',
    'viewContainers.sourceControl.noRepositoryDescription':
        'This Project root is not a repository yet.',
    'viewContainers.sourceControl.gitUnavailable': 'Git is not available',
    'viewContainers.sourceControl.unavailable': 'Source Control is unavailable right now.',
    'viewContainers.sourceControl.refreshFailed': 'Source Control refresh failed',
    'viewContainers.sourceControl.actionFailed': 'Source Control action failed',
    'viewContainers.sourceControl.refreshingAction':
        'Source Control is refreshing. Try that action again in a moment.',
    'viewContainers.sourceControl.stateSaveFailed': 'Source Control view state could not be saved',
    'viewContainers.sourceControl.hintSeparator': '. ',
    'viewContainers.sourceControl.rowMenuHint': 'Press Shift+F10 for actions',
    'viewContainers.sourceControl.commandClickHint': 'Command-click to {{action}}',
    'viewContainers.sourceControl.optionClickHint':
        'Option-click to expand or collapse everything below',
    'viewContainers.sourceControl.pathLabel': 'Path',
    'viewContainers.sourceControl.hiddenCount': '{{count}} hidden',
    'viewContainers.sourceControl.changedFilesOne': '{{count}} changed file',
    'viewContainers.sourceControl.changedFilesOther': '{{count}} changed files',
    'viewContainers.sourceControl.filesOne': '{{count}} file',
    'viewContainers.sourceControl.filesOther': '{{count}} files',
    'viewContainers.sourceControl.lineStatsTooltip':
        '{{stats}}. Lines changed in the listed files, including new files.',
    'viewContainers.sourceControl.branch.switchBranch': 'Switch Branch…',
    'viewContainers.sourceControl.branch.switchBranchesHint':
        'Click or press Enter to switch branches',
    'viewContainers.sourceControl.branch.switchToBranchHint':
        'Click or press Enter to switch to a branch',
    'viewContainers.sourceControl.branch.syncHint': 'Click {{badge}} to sync changes',
    'viewContainers.sourceControl.sync.title': 'Sync this branch?',
    'viewContainers.sourceControl.sync.titleRemote': 'Sync with {{remote}}?',
    'viewContainers.sourceControl.sync.message': 'This will {{summary}}.',
    'viewContainers.sourceControl.sync.confirm': 'Sync',
    'viewContainers.sourceControl.sync.remoteFallback': 'its remote branch',
    'viewContainers.sourceControl.sync.pull': 'pull {{commits}} from {{target}}',
    'viewContainers.sourceControl.sync.push': 'push {{commits}} to {{target}}',
    'viewContainers.sourceControl.sync.stepSeparator': ', then ',
    'viewContainers.sourceControl.sync.fallbackSummary': 'sync with {{target}}',
    'viewContainers.sourceControl.sync.commitsOne': '{{count}} commit',
    'viewContainers.sourceControl.sync.commitsOther': '{{count}} commits',
} as const;
