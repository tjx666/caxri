/**
 * The Session's pull request: the header chip and the merge sheet. Readiness and confirmation wording follows the
 * Desktop Status panel's merge button.
 */
export const pullRequest = {
    'pullRequest.chip': 'Pull request #{{number}}, {{status}}',
    'pullRequest.chipHint': 'Shows checks and merge options',
    'pullRequest.close': 'Close pull request details',
    'pullRequest.lifecycle.closed': 'Closed without merging',
    'pullRequest.lifecycle.draft': 'Draft',
    'pullRequest.lifecycle.merged': 'Merged',
    'pullRequest.readiness.ready': 'Ready to merge',
    'pullRequest.readiness.conflicting': 'Has conflicts',
    'pullRequest.readiness.checksFailed': 'Checks did not pass',
    'pullRequest.readiness.checksRunning': 'Checks still running',
    'pullRequest.readiness.branchProtection': 'Blocked by branch protection',
    'pullRequest.readiness.behind': 'Behind its base branch',
    'pullRequest.readiness.unknown': 'Checking mergeability',
    'pullRequest.checks.failed': '{{failed}} of {{total}} checks failed: {{names}}',
    'pullRequest.checks.namesWithMore': '{{names}}, and {{count}} more',
    'pullRequest.checks.passedOne': '{{count}} check passed',
    'pullRequest.checks.passedOther': '{{count}} checks passed',
    'pullRequest.checks.running': 'Checks running',
    'pullRequest.checks.someFailed': 'Some checks did not pass',
    'pullRequest.merge': 'Merge',
    'pullRequest.mergeAnyway': 'Merge anyway',
    'pullRequest.merging': 'Merging…',
    'pullRequest.mergeMethod':
        'Squash and merge when the repository allows it, otherwise a merge commit, then rebase.',
    'pullRequest.method.squash': 'Squash and merge',
    'pullRequest.method.merge': 'Create a merge commit',
    'pullRequest.method.rebase': 'Rebase and merge',
    'pullRequest.method.into': '{{action}} into {{base}}.',
    'pullRequest.method.plain': '{{action}}.',
    'pullRequest.method.noSquash': 'This repository does not allow squash merging.',
    'pullRequest.method.noSquashOrMerge':
        'This repository allows neither squash merging nor merge commits.',
    'pullRequest.confirm.title': 'Merge #{{number}}?',
    'pullRequest.confirm.checksFailed': 'Checks did not pass.',
    'pullRequest.confirm.checksRunning': 'Checks are still running.',
    'pullRequest.confirm.branchProtection':
        'A branch protection requirement is not met yet, so GitHub may refuse the merge.',
    'pullRequest.confirm.behind':
        'The branch is behind its base, so GitHub may require updating it first.',
    'pullRequest.confirm.unknown':
        'GitHub has not finished checking whether this pull request can merge.',
    'pullRequest.confirm.undo': 'A merged pull request cannot be undone from Caxri.',
    'pullRequest.back': 'Back',
    'pullRequest.refusedConflict':
        'GitHub cannot merge a pull request with conflicts. Ask the Agent to resolve them first.',
    'pullRequest.draftNote':
        "GitHub can't merge a draft. Mark it ready for review on GitHub, then merge it here.",
    'pullRequest.waitingHead': 'Waiting for GitHub to report the latest commit.',
    'pullRequest.needsControl': 'This device needs control access to merge pull requests.',
    'pullRequest.offline': 'Reconnect to merge this pull request.',
    'pullRequest.openOnGitHub': 'Open on GitHub',
    'pullRequest.merged.squash': 'Squashed and merged #{{number}}.',
    'pullRequest.merged.merge': 'Merged #{{number}} with a merge commit.',
    'pullRequest.merged.rebase': 'Rebased and merged #{{number}}.',
    'pullRequest.mergeFailed': 'GitHub did not merge this pull request. {{reason}}',
    'pullRequest.mergeLostConnection':
        'Lost connection before GitHub answered. Checking the pull request…',
    'pullRequest.mergeConflict': 'This pull request now has conflicts.',
    'pullRequest.mergeStale': 'This pull request changed. Review it again before merging.',
    'pullRequest.mergeForbidden': 'This device is not allowed to merge pull requests.',
};
