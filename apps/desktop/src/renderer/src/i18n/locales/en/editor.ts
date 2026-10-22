export const editor = {
    // Tab rail actions for files and single-file diffs.
    'editor.tabActions.openLastCommitChanges': 'Open Last Commit Changes',
    'editor.tabActions.openPullRequestChanges': 'Open Pull Request Changes',
    'editor.tabActions.previousChange': 'Previous Change',
    'editor.tabActions.nextChange': 'Next Change',
    'editor.tabActions.fileDeleted': 'File was deleted',
    'editor.tabActions.openCurrentFile': 'Open Current File',

    // Diff view options popover.
    'editor.diffOptions.title': 'Diff View Options',
    'editor.diffOptions.inlineView': 'Inline View',
    'editor.diffOptions.collapseUnchanged': 'Collapse Unchanged Regions',
    'editor.diffOptions.showWhitespace': 'Show Leading/Trailing Whitespace Differences',

    // Review comment cards and the Monaco action that adds one.
    'editor.review.addComment': 'Add Review Comment',
    'editor.review.cardLabel': 'Review comment for lines {{start}} to {{end}}',
    'editor.review.heading': 'Review · {{side}} L{{lines}}',
    'editor.review.side.original': 'Old',
    'editor.review.side.modified': 'New',
    'editor.review.status.pending': 'pending',
    'editor.review.status.sent': 'sent',
    'editor.review.status.outdated': 'outdated',
    'editor.review.commentInput': 'Review comment',
    'editor.review.readPendingFailed': 'Could not read pending review comments',
    'editor.review.noPending': 'No pending review comments',

    // Sending review comments to an Agent.
    'editor.reviewSend.clearResolved': 'Clear sent and outdated',
    'editor.reviewSend.sendToAgentOne': 'Send {{count}} comment to Agent',
    'editor.reviewSend.sendToAgentOther': 'Send {{count}} comments to Agent',
    'editor.reviewSend.dialogTitle': 'Send review comments to Agent',
    'editor.reviewSend.dialogDescription':
        "Review the text before sending it to the current Session's Agent.",
    'editor.reviewSend.promptPreview': 'Review comment prompt preview',
    'editor.reviewSend.sending': 'Sending…',
    'editor.reviewSend.sendOne': 'Send {{count}} comment',
    'editor.reviewSend.sendOther': 'Send {{count}} comments',
    'editor.reviewSend.noAgentTerminal': 'No Agent in this Session',
    'editor.reviewSend.agentNotReady': 'Agent Terminal is not ready for input',
    'editor.reviewSend.failed': 'Unable to send review comments',

    // Breadcrumbs and the sibling picker.
    'editor.breadcrumbs.fileLabel': 'File breadcrumbs: {{path}}',
    'editor.breadcrumbs.diffLabel': 'Diff breadcrumbs: {{path}}',
    'editor.breadcrumbs.diffLabelRenamed':
        'Diff breadcrumbs: {{path}} (renamed from {{originalPath}})',
    'editor.breadcrumbs.browse': 'Browse {{path}}',
    'editor.breadcrumbs.readOnly': 'Read-only',
    'editor.breadcrumbs.projectRoot': 'Project root',
    'editor.breadcrumbs.contentsOf': 'Contents of {{directory}}',
    'editor.breadcrumbs.loadingFolder': 'Loading folder…',
    'editor.breadcrumbs.readFolderFailed': 'Unable to read folder',
    'editor.breadcrumbs.emptyFolder': 'Empty folder',
    'editor.breadcrumbs.truncated': 'Showing the first {{count}} items',
    'editor.breadcrumbs.openPathFailed': 'Unable to open path',

    // Editor surface loading and failure states.
    'editor.load.editorFailed': "The editor didn't load. Reloading the window usually fixes it.",
    'editor.load.renderFailed':
        'This tab ran into an error. Reloading the window usually fixes it.',
    'editor.load.reloadWindow': 'Reload window',
    'editor.load.openWithDefaultApp': 'Open with Default App',
    'editor.load.loadingEditor': 'Loading editor…',
    'editor.load.externalUnavailable': 'External file is no longer available.',
    'editor.load.loadingFile': 'Loading file…',
    'editor.load.loadingDiffEditor': 'Loading diff editor…',
    'editor.load.loadingTranscript': 'Loading transcript…',
    'editor.load.loadingTask': 'Loading task…',
    'editor.load.loadingChanges': 'Loading changes…',
    'editor.load.loadingAgentStatus': 'Loading Agent status…',
    'editor.load.loadingAgentContext': 'Loading context…',
    'editor.load.loadingAgentSideChat': 'Loading side chat…',
    'editor.load.loadingSettings': 'Loading Settings…',
    'editor.load.loadingUsage': 'Loading Usage…',

    // Agent transcript viewer.
    'editor.transcript.loadFailed': 'Unable to load transcript',
    'editor.transcript.unbound': 'This terminal has no bound agent transcript to show.',
    'editor.transcript.notFound': 'Transcript file not found.',
    'editor.transcript.truncated': 'Truncated — showing the newest part',
    'editor.transcript.jumpToLatest': 'Jump to Latest',

    // Git diff surfaces.
    'editor.gitDiff.resolvedReason':
        'This file no longer differs from what the diff compared. The change was committed or undone.',
    'editor.gitDiff.checkAgain': 'Check again',
    'editor.gitDiff.checking': 'Checking…',
    'editor.gitDiff.stallReason':
        "Couldn't compare these two versions. This isn't a result — the comparison never finished, so the file may well have changed.",
    'editor.gitDiff.workerNotStartedReason':
        "Couldn't compare these two versions. This comparison never started, so the file may well have changed. Choose Retry.",
    'editor.gitDiff.retrying': 'Comparing these two versions again…',
    'editor.gitDiff.openFailed': 'Unable to open Git diff',
    'editor.gitDiff.loading': 'Loading diff…',
    'editor.gitDiff.openFile': 'Open File',
    'editor.gitDiff.openFileNamed': 'Open {{path}}',
    'editor.gitDiff.openChangesFailed': 'Unable to open Git changes',
    'editor.gitDiff.repositoryUnavailable': 'Git repository is no longer available',
    'editor.gitDiff.workingTreeClean': 'Working tree clean.',
    'editor.gitDiff.openPullRequestChangesFailed': 'Unable to open pull request changes',
    'editor.gitDiff.loadingPullRequestChanges': 'Loading pull request changes…',
    'editor.gitDiff.noPullRequest': 'No pull request for this branch.',
    'editor.gitDiff.pullRequestEmpty': 'Pull request has no file changes.',
    'editor.gitDiff.addedContents': 'Added file contents',
    'editor.gitDiff.deletedContents': 'Deleted file contents',
    'editor.gitDiff.showExcluded': 'Show them',
    'editor.gitDiff.editExclusions': 'Edit exclusions…',
    'editor.gitDiff.truncated': 'Showing the first {{visible}} of {{total}} changes',
    'editor.gitDiff.hiddenOne': '{{count}} changed file is hidden by Git diff exclusions.',
    'editor.gitDiff.hiddenOther': '{{count}} changed files are hidden by Git diff exclusions.',
    'editor.gitDiff.allHiddenOne': 'All {{count}} changed file is hidden by Git diff exclusions.',
    'editor.gitDiff.allHiddenOther':
        'All {{count}} changed files are hidden by Git diff exclusions.',
    'editor.gitDiff.allHiddenLoadedOne':
        'All {{count}} loaded changed file is hidden by Git diff exclusions.',
    'editor.gitDiff.allHiddenLoadedOther':
        'All {{count}} loaded changed files are hidden by Git diff exclusions.',

    // Editor tab labels and descriptions.
    'editor.tab.outsideProject': 'Outside every Project',
    'editor.tab.turnChanges': 'Turn changes',
    'editor.tab.changes': 'Changes: {{repository}}',
    'editor.tab.pullRequestChanges': 'PR Changes: {{repository}}',
    'editor.tab.transcript': 'Transcript',
    'editor.tab.transcriptNamed': 'Transcript: {{title}}',
    'editor.tab.subagent': 'Subagent',
    'editor.tab.agentStatus': '{{agent}} Status',
    'editor.tab.agentContext': 'Context',
    'editor.tab.agentSideChat': 'Side chat',
    'editor.tab.preview': 'Preview: {{name}}',
    'editor.tab.settings': 'Settings',
    'editor.tab.usage': 'Usage',

    // Editor tab context menu.
    'editor.pathMenu.openSource': 'Open Source',
    'editor.pathMenu.openPreview': 'Open Preview',
    'editor.pathMenu.revealInFinder': 'Reveal in Finder',
    'editor.pathMenu.openInTerminal': 'Open in Terminal',
    'editor.pathMenu.copyPath': 'Copy Path',
    'editor.pathMenu.copyRelativePath': 'Copy Relative Path',
    'editor.pathMenu.repositoryLoadFailed': 'Unable to load repository information',
    'editor.pathMenu.repositoryLoading': 'Repository information is still loading',
    'editor.pathMenu.pathUnavailable': 'The file path is unavailable',

    // Status bar language names that are words rather than product names.
    'editor.language.plaintext': 'Plain Text',
    'editor.language.jsonc': 'JSON with Comments',
    'editor.language.rc': 'Configuration',
    'editor.language.shell': 'Shell Script',

    // Sending a file reference to a Terminal.
    'editor.sendReference.noTerminal': 'Open a Terminal in this Session first',
    'editor.sendReference.terminalNotReady': 'Terminal is not ready for input',

    // Opening import paths.
    'editor.importLink.noImport': 'Put the cursor on an import path to open it.',
    'editor.importLink.resolveFailed': 'Unable to resolve {{specifier}}',
    'editor.importLink.notInProject': '{{specifier}} does not resolve to a file in this Project.',

    // Document open, save, move, and trash feedback.
    'editor.document.openFailed': "Couldn't open this file",
    'editor.document.noRoom':
        'There is no room left for another open file. Save or close some files, then try again.',
    'editor.document.openFileFailed': 'Unable to open file',
    'editor.document.saveFailedFile': "Couldn't save {{name}}",
    'editor.document.saveRetryUnavailable':
        'Save retry is no longer available because the editor was closed or its Project changed.',
    'editor.document.moveStateSaveFailed': 'Moved editor state could not be saved',
    'editor.document.trashStateSaveFailed': 'Trashed editor state could not be saved',

    // External changes that replaced unsaved buffers.
    'editor.externalSync.discardedOne':
        'Your unsaved changes to {{name}} were replaced by changes on disk.',
    'editor.externalSync.discardedOther':
        'Your unsaved changes to {{count}} files were replaced by changes on disk.',
    'editor.discarded.alreadyRestored': 'Your earlier changes were already restored.',
    'editor.discarded.unavailable':
        'Your earlier changes can no longer be restored because the file was closed, edited again, or its Project changed.',

    // Files opened through a link in an external document.
    'editor.external.openInSessionFailed': 'Unable to open the linked file in this Session',
    'editor.external.openFailed': 'Unable to open the linked file',

    // Save All for buffers under a Workbench Root that is not open.
    'editor.unsaved.listSeparator': ', ',
    'editor.unsaved.listMore': '{{names}}, and {{count}} more',
    'editor.unsaved.listPair': '{{names}} and {{last}}',
    'editor.unsaved.unreachableOne':
        "{{subject}} belongs to a Workbench Root that is not open. Switch back to it to save, or choose Don't Save.",
    'editor.unsaved.unreachableOther':
        "{{subject}} belong to a Workbench Root that is not open. Switch back to it to save, or choose Don't Save.",
} as const;
