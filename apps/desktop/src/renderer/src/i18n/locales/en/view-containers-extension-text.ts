/**
 * Chrome strings of the bundled Git and Status extensions. The extensions send these in English (they cannot read the
 * interface language); the Renderer matches each one against its English value here and shows the translation. A value
 * with `{{name}}` placeholders matches the extension's templated sentence. See `docs/i18n.md`, "Strings owned by
 * bundled extensions".
 */
export const viewContainersExtensionText = {
    'viewContainers.extensionText.sourceControl.title': 'Source Control',
    'viewContainers.extensionText.sourceControl.repositories': 'Git repositories',
    'viewContainers.extensionText.sourceControl.mode': 'Source control mode',
    'viewContainers.extensionText.sourceControl.modeWorking': 'Working Tree Changes',
    'viewContainers.extensionText.sourceControl.modeLastCommit': 'Last Commit Changes',
    'viewContainers.extensionText.sourceControl.modeCommit': 'Commit Changes ({{sha}})',
    'viewContainers.extensionText.sourceControl.modePullRequest': 'Pull Request Changes',
    'viewContainers.extensionText.sourceControl.refreshPullRequest': 'Refresh Pull Request',
    'viewContainers.extensionText.sourceControl.refreshGit': 'Refresh Git',
    'viewContainers.extensionText.sourceControl.hideExcluded': 'Hide excluded files ({{count}})',
    'viewContainers.extensionText.sourceControl.showExcluded': 'Show excluded files ({{count}})',
    'viewContainers.extensionText.sourceControl.groupChanges': 'Changes',
    'viewContainers.extensionText.sourceControl.groupLastCommit': 'Last Commit',
    'viewContainers.extensionText.sourceControl.groupCommit': 'Commit {{sha}}',
    'viewContainers.extensionText.sourceControl.groupPullRequest': 'PR #{{number}} Changes',
    'viewContainers.extensionText.sourceControl.fileHistory': 'File History',
    'viewContainers.extensionText.sourceControl.fileHistoryEmpty':
        'Open a file to view its history.',
    'viewContainers.extensionText.sourceControl.commits': 'Commits',
    'viewContainers.extensionText.sourceControl.historyPathFor': 'History path for {{name}}',
    'viewContainers.extensionText.sourceControl.historyPathPlaceholder': 'History path (optional)',
    'viewContainers.extensionText.sourceControl.historyPathClear': 'Clear history path',
    'viewContainers.extensionText.sourceControl.loadingFileHistory': 'Loading file history…',
    'viewContainers.extensionText.sourceControl.loadingCommits': 'Loading commits…',
    'viewContainers.extensionText.sourceControl.noFileHistory': 'No file history.',
    'viewContainers.extensionText.sourceControl.noCommits': 'No commits.',
    'viewContainers.extensionText.sourceControl.loadMoreCommits': 'Load more commits',
    'viewContainers.extensionText.sourceControl.loadingMore': 'Loading…',
    'viewContainers.extensionText.sourceControl.fileHistoryLoadFailed':
        'Unable to load file history',
    'viewContainers.extensionText.sourceControl.commitsLoadFailed': 'Unable to load commits',
    'viewContainers.extensionText.sourceControl.loadingCommit': 'Loading commit…',
    'viewContainers.extensionText.sourceControl.commitLoadFailed': 'Unable to load commit',
    'viewContainers.extensionText.sourceControl.changedFiles': 'Changed files',
    'viewContainers.extensionText.sourceControl.noFilesInScope': 'No files in this scope.',
    'viewContainers.extensionText.sourceControl.fileListTruncated': 'File list truncated.',
    'viewContainers.extensionText.sourceControl.commitPrefix': 'Commit',
    'viewContainers.extensionText.sourceControl.noSubject': '(no subject)',
    'viewContainers.extensionText.sourceControl.openChangesIn': 'Open changes in {{path}}',
    'viewContainers.extensionText.sourceControl.discardFailed': 'Discard failed',
    'viewContainers.extensionText.sourceControl.deleteFile': 'Delete File',
    'viewContainers.extensionText.sourceControl.discardChanges': 'Discard Changes',
    'viewContainers.extensionText.sourceControl.deleteNamed': 'Delete {{name}}',
    'viewContainers.extensionText.sourceControl.discardChangesIn': 'Discard changes in {{name}}',
    'viewContainers.extensionText.sourceControl.discardAll': 'Discard All Changes',
    'viewContainers.extensionText.sourceControl.discardAllNotLoaded':
        'Some changes are not loaded. Show excluded files before discarding all changes.',
    'viewContainers.extensionText.sourceControl.discardAllExcluded':
        'Show excluded files to discard all changes.',
    'viewContainers.extensionText.sourceControl.openPullRequestChanges':
        'Open Pull Request Changes',
    'viewContainers.extensionText.sourceControl.openWorkingTreeChanges':
        'Open Working Tree Changes',
    'viewContainers.extensionText.sourceControl.openChanges': 'Open Changes',
    'viewContainers.extensionText.sourceControl.openPullRequestOnWeb':
        'Open pull request #{{number}} on the web',
    'viewContainers.extensionText.sourceControl.syncIn': 'Sync Changes in {{name}}',
    'viewContainers.extensionText.sourceControl.syncing': 'Syncing {{name}}',
    'viewContainers.extensionText.sourceControl.syncFailed': 'Sync failed',
    'viewContainers.extensionText.sourceControl.syncTooltip': 'Sync Changes (Pull, then Push)',
    'viewContainers.extensionText.sourceControl.upToDate': 'Already up to date',
    'viewContainers.extensionText.sourceControl.synced': 'Synced with remote',
    'viewContainers.extensionText.sourceControl.workingTreeClean': 'Working tree clean.',
    'viewContainers.extensionText.sourceControl.noCommitsYet': 'No commits yet.',
    'viewContainers.extensionText.sourceControl.commitUnableNamed':
        'Unable to load commit {{sha}}.',
    'viewContainers.extensionText.sourceControl.commitUnableLast':
        'Unable to load the last commit.',
    'viewContainers.extensionText.sourceControl.commitNoChangesNamed':
        'Commit {{sha}} has no file changes.',
    'viewContainers.extensionText.sourceControl.commitLoadingNamed': 'Loading commit {{sha}}…',
    'viewContainers.extensionText.sourceControl.commitNoChangesLast':
        'Last commit has no file changes.',
    'viewContainers.extensionText.sourceControl.commitLoadingLast': 'Loading last commit…',
    'viewContainers.extensionText.sourceControl.detachedNoPullRequest':
        'Detached HEAD has no pull request. Switch to a branch to see one.',
    'viewContainers.extensionText.sourceControl.pullRequestLoadFailed':
        'Unable to load pull request changes. Refresh to retry.',
    'viewContainers.extensionText.sourceControl.noPullRequest': 'No pull request for this branch.',
    'viewContainers.extensionText.sourceControl.pullRequestNoChanges':
        'Pull request has no file changes.',
    'viewContainers.extensionText.sourceControl.pullRequestLoading':
        'Loading pull request changes…',
    'viewContainers.extensionText.sourceControl.excludedHiddenOne':
        '{{count}} excluded file hidden.',
    'viewContainers.extensionText.sourceControl.excludedHiddenOther':
        '{{count}} excluded files hidden.',
    'viewContainers.extensionText.sourceControl.truncatedChanges':
        'Showing the first {{shown}} of {{total}} changes',
    'viewContainers.extensionText.sourceControl.truncatedCommitFiles':
        'Showing the first {{count}} files of this commit',
    'viewContainers.extensionText.sourceControl.truncatedPayload':
        'Some Source Control resources are hidden because this workspace exceeds the display limit.',
    'viewContainers.extensionText.sourceControl.notRepository':
        'This folder is not a Git repository.',
    'viewContainers.extensionText.sourceControl.unavailable':
        'Source Control is unavailable right now.',
    'viewContainers.extensionText.sourceControl.unavailableWithError':
        'Source Control is unavailable right now. {{error}}',
    'viewContainers.extensionText.sourceControl.noApprovedRepositories':
        'No approved Git repositories found.',
    'viewContainers.extensionText.sourceControl.detachedHead': 'Detached HEAD',
    'viewContainers.extensionText.sourceControl.detachedHeadAt': 'Detached HEAD at {{ref}}',
    'viewContainers.extensionText.sourceControl.detachedBadge': 'detached',
    'viewContainers.extensionText.sourceControl.ahead': '{{count}} ahead',
    'viewContainers.extensionText.sourceControl.behind': '{{count}} behind',
    'viewContainers.extensionText.sourceControl.tracking': 'tracking {{ref}}',
    'viewContainers.extensionText.sourceControl.pullRequestInto':
        'Pull request #{{number}} into {{base}}: {{title}}',
    'viewContainers.extensionText.sourceControl.unpushedLocalOne':
        '{{count}} local commit is not included in pull request #{{number}}',
    'viewContainers.extensionText.sourceControl.unpushedLocalOther':
        '{{count}} local commits are not included in pull request #{{number}}',
    'viewContainers.extensionText.sourceControl.kindWorktree': 'worktree',
    'viewContainers.extensionText.sourceControl.kindNested': 'nested',
    'viewContainers.extensionText.sourceControl.kindSubmodule': 'submodule',
    'viewContainers.extensionText.sourceControl.countUnavailable': 'Unavailable',
    'viewContainers.extensionText.sourceControl.countUnpushed': '{{count}} unpushed',
    'viewContainers.extensionText.sourceControl.countUncommitted': '{{count}} uncommitted',
    'viewContainers.extensionText.sourceControl.uncommittedOne':
        '{{count}} uncommitted change in {{name}}',
    'viewContainers.extensionText.sourceControl.uncommittedOther':
        '{{count}} uncommitted changes in {{name}}',
    'viewContainers.extensionText.sourceControl.uncommittedShowOne':
        '{{count}} uncommitted change in {{name}}. Show Working Tree Changes.',
    'viewContainers.extensionText.sourceControl.uncommittedShowOther':
        '{{count}} uncommitted changes in {{name}}. Show Working Tree Changes.',
    'viewContainers.extensionText.sourceControl.filesChangedOne': '{{count}} file changed',
    'viewContainers.extensionText.sourceControl.filesChangedOther': '{{count}} files changed',
    'viewContainers.extensionText.sourceControl.hiddenCount': '{{count}} hidden',
    'viewContainers.extensionText.status.noRepository': 'No Git repository',
    'viewContainers.extensionText.status.initializeRepository':
        'Initialize a Git repository in the Project root, then refresh.',
    'viewContainers.extensionText.status.unavailable': 'Project Status unavailable',
    'viewContainers.extensionText.status.noRepositories': 'No repositories found',
    'viewContainers.extensionText.status.addRepository':
        'Add a Git repository to this Project, then refresh.',
    'viewContainers.extensionText.status.refresh': 'Refresh',
    'viewContainers.extensionText.status.openLogs': 'Open Logs',
    'viewContainers.extensionText.status.deployments': 'Deployments',
    'viewContainers.extensionText.status.noNetwork': 'No network connection',
    'viewContainers.extensionText.status.rowBranch': 'branch',
    'viewContainers.extensionText.status.rowRepository': 'repository',
    'viewContainers.extensionText.status.rowPullRequest': 'pull request',
    'viewContainers.extensionText.status.rowComparedBranch': 'compared branch',
    'viewContainers.extensionText.status.rowChecked': 'checked',
    'viewContainers.extensionText.status.rowDefault': 'default',
    'viewContainers.extensionText.status.rowChecks': 'checks',
    'viewContainers.extensionText.status.rowMerge': 'merge',
    'viewContainers.extensionText.status.rowHidden': 'hidden',
    'viewContainers.extensionText.status.publicationChecking': 'Checking origin…',
    'viewContainers.extensionText.status.publicationUnpublished': 'Not on origin',
    'viewContainers.extensionText.status.publicationPublished': 'On origin',
    'viewContainers.extensionText.status.publicationSynced': 'Synced',
    'viewContainers.extensionText.status.publicationUnknown': 'Check failed',
    'viewContainers.extensionText.status.publicationNoOrigin': 'No origin',
    'viewContainers.extensionText.status.publicationUnsupported': 'Not supported',
    'viewContainers.extensionText.status.publicationUnborn': 'No commits',
    'viewContainers.extensionText.status.descUnpublished':
        'No same-named branch exists on origin. It may exist on another remote or under another name.',
    'viewContainers.extensionText.status.descPublished':
        'The branch exists on origin, but local history is insufficient to compare commits. This does not confirm that every local commit has been pushed.',
    'viewContainers.extensionText.status.descSynced':
        'Local and origin branch tips match at the checked time.',
    'viewContainers.extensionText.status.descAhead':
        'Local commits not on the compared origin branch at the checked time.',
    'viewContainers.extensionText.status.descBehind':
        'Origin commits not on the local branch at the checked time.',
    'viewContainers.extensionText.status.descDiverged':
        'Both branches have commits absent from the other at the checked time.',
    'viewContainers.extensionText.status.descUnknown':
        'Could not verify the branch on origin. Refresh Project Status to check again.',
    'viewContainers.extensionText.status.descUnsupported':
        'Remote verification currently supports GitHub origins only.',
    'viewContainers.extensionText.status.descNoOrigin':
        'Project Status compares this branch with a GitHub remote named origin, and this repository has none. Add one with `git remote add origin <url>`, then refresh.',
    'viewContainers.extensionText.status.descDetached': 'HEAD is not attached to a local branch.',
    'viewContainers.extensionText.status.descUnborn': 'This branch has no commits yet.',
    'viewContainers.extensionText.status.descChecking': 'Checking the same-named branch on origin.',
    'viewContainers.extensionText.status.noDeployments': 'No Vercel deployments found',
    'viewContainers.extensionText.status.noDeploymentsHint':
        'This repository is linked to Vercel, but no matching deployments were found. Create one, then recheck.',
    'viewContainers.extensionText.status.cliNotInstalled': '{{provider}} not installed',
    'viewContainers.extensionText.status.cliNotSignedIn': '{{provider}} not signed in',
    'viewContainers.extensionText.status.cliNotLinked': '{{provider}} not linked',
    'viewContainers.extensionText.status.vercelNotLinked': 'Repository not linked to Vercel',
    'viewContainers.extensionText.status.cliAccessDenied': '{{provider}} access denied',
    'viewContainers.extensionText.status.cliConnectionFailed': '{{provider}} connection failed',
    'viewContainers.extensionText.status.cliTlsFailed': '{{provider}} secure connection failed',
    'viewContainers.extensionText.status.apiLimitReached': '{{service}} API limit reached',
    'viewContainers.extensionText.status.cliTimedOut': '{{provider}} timed out',
    'viewContainers.extensionText.status.cliFailed': '{{provider}} failed',
    'viewContainers.extensionText.status.cliSubjectFailed': '{{provider}}: {{subject}} failed',
    'viewContainers.extensionText.status.installGitHub':
        'Pull requests for this repository need the GitHub CLI. Install it, then recheck.',
    'viewContainers.extensionText.status.installLobeHub':
        'Acceptance reports need the LobeHub CLI. Install it with npm i -g @lobehub/cli, then recheck.',
    'viewContainers.extensionText.status.installLinear':
        'Linked issues need the Linear CLI. Install it, then recheck.',
    'viewContainers.extensionText.status.installVercel':
        'Deployments for this repository need the Vercel CLI. Install it with npm i -g vercel, then recheck.',
    'viewContainers.extensionText.status.signInHint':
        'Run {{command}} in a Terminal, then recheck. A {{variable}} environment variable alone is not enough — Caxri does not forward personal shell credentials to CLI checks.',
    'viewContainers.extensionText.status.linkLinear':
        'Run linear config in this repository, then recheck.',
    'viewContainers.extensionText.status.linkVercel':
        'Run vc link in this repository, then recheck.',
    'viewContainers.extensionText.status.linkGeneric':
        'Configure {{service}} for this repository, then recheck.',
    'viewContainers.extensionText.status.accessGitHub':
        'Run gh auth refresh, authorize SSO for the organization if it requires it, then recheck.',
    'viewContainers.extensionText.status.accessLobeHub':
        'Check that your LobeHub account can read this report, then recheck.',
    'viewContainers.extensionText.status.accessLinear':
        'Check that your Linear account can see this team, then recheck.',
    'viewContainers.extensionText.status.accessVercel':
        'Check that your Vercel account can access this project, then recheck.',
    'viewContainers.extensionText.status.couldNotReach':
        'Caxri could not reach {{provider}}. Check the connection, then recheck.',
    'viewContainers.extensionText.status.couldNotReachShared':
        'Caxri could not reach {{providers}}. Reconnect, then refresh.',
    'viewContainers.extensionText.status.tlsHint': 'Check your proxy or certificates, then retry.',
    'viewContainers.extensionText.status.rateLimitRetry':
        'Caxri paused {{service}} checks to protect the shared API budget. Retries after {{time}}.',
    'viewContainers.extensionText.status.rateLimitRefresh':
        'Caxri paused {{service}} checks to protect the shared API budget. Refresh after the limit resets.',
    'viewContainers.extensionText.status.timeoutHint': 'Check the network or proxy, then refresh.',
    'viewContainers.extensionText.status.failedPullRequests':
        'Something went wrong while loading pull requests. Open Logs for details.',
    'viewContainers.extensionText.status.failedAcceptance':
        'Something went wrong while loading acceptance reports. Open Logs for details.',
    'viewContainers.extensionText.status.failedIssues':
        'Something went wrong while loading linked issues. Open Logs for details.',
    'viewContainers.extensionText.status.failedDeployments':
        'Something went wrong while loading deployments. Open Logs for details.',
    'viewContainers.extensionText.status.statePassed': 'passed',
    'viewContainers.extensionText.status.stateFailed': 'failed',
    'viewContainers.extensionText.status.stateCanceled': 'canceled',
    'viewContainers.extensionText.status.stateRunning': 'running',
    'viewContainers.extensionText.status.stateQueued': 'queued',
    'viewContainers.extensionText.status.stateNeutral': 'neutral',
    'viewContainers.extensionText.status.stateUnknown': 'unknown',
    'viewContainers.extensionText.status.ciPassed': 'CI passed',
    'viewContainers.extensionText.status.ciFailed': 'CI failed',
    'viewContainers.extensionText.status.ciCanceled': 'CI canceled',
    'viewContainers.extensionText.status.ciRunning': 'CI running',
    'viewContainers.extensionText.status.ciQueued': 'CI queued',
    'viewContainers.extensionText.status.ciNeutral': 'CI neutral',
    'viewContainers.extensionText.status.ciUnknown': 'CI unknown',
} as const;
