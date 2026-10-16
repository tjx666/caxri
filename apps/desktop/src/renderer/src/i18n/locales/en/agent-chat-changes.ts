/**
 * Agent Chat file changes, turn review, Undo and rewind, and background task strings.
 */
export const agentChatChanges = {
    // File change blocks and their diffs
    'agentChat.changes.noDiff': 'No diff',
    'agentChat.changes.commentOnOldLine': 'Comment on old line {{line}}',
    'agentChat.changes.commentOnLine': 'Comment on line {{line}}',
    'agentChat.changes.diffTruncated': 'Diff truncated',
    'agentChat.changes.openDiff': 'Open diff',
    'agentChat.changes.openDiffFor': 'Open diff: {{path}}',
    'agentChat.changes.showDiffFor': 'Show diff: {{path}}',
    'agentChat.changes.hideDiffFor': 'Hide diff: {{path}}',
    'agentChat.changes.openInEditor': 'Open in Editor',
    'agentChat.changes.openPathInEditor': 'Open {{path}} in Editor',
    'agentChat.changes.truncated': 'Truncated',

    // Turn changes card
    'agentChat.changes.showFileChanges': 'Show changes: {{path}}, {{stat}}',
    'agentChat.changes.hideFileChanges': 'Hide changes: {{path}}, {{stat}}',
    'agentChat.changes.viewAllWithStat': 'View changes, {{stat}}',
    'agentChat.changes.hideAllWithStat': 'Hide changes, {{stat}}',
    'agentChat.changes.viewChanges': 'View changes',
    'agentChat.changes.hideChanges': 'Hide changes',
    'agentChat.changes.showMoreFilesOne': 'Show {{count}} more file',
    'agentChat.changes.showMoreFilesOther': 'Show {{count}} more files',
    'agentChat.changes.showFewerFiles': 'Show fewer files',
    'agentChat.undo.undone': 'Undone',
    'agentChat.undo.truncatedTooltip':
        'A diff was too large to keep in full, so this turn cannot be undone',
    'agentChat.undo.partialTurnTooltip':
        'The start of this turn is no longer in the Chat, so it cannot be undone in full',
    'agentChat.undo.tooltip': 'Restore the files to how they were before this turn',
    'agentChat.undo.button': 'Undo',
    'agentChat.review.tooltip': "Review this turn's changes beside the Chat and comment on them",
    'agentChat.review.button': 'Review',

    // Turn review tab
    'agentChat.review.loading': 'Loading changes…',
    'agentChat.review.unavailable': 'This Chat is no longer available to review.',
    'agentChat.review.noChanges': 'This turn has no file changes to review.',
    'agentChat.review.backToChat': 'Back to Chat',
    'agentChat.review.title': 'Turn changes',
    'agentChat.review.fileCountOne': '1 file',
    'agentChat.review.fileCountOther': '{{count}} files',

    // Review comment card
    'agentChat.review.commentGroup': 'Review comment',
    'agentChat.review.commentOnThisLine': 'Comment on this line',
    'agentChat.review.commentOnLines': 'Comment on {{count}} lines',
    'agentChat.review.extendHint': 'Shift-click + to extend',
    'agentChat.review.commentLabel': 'Comment',
    'agentChat.review.commentPlaceholder': 'Ask the Agent to change something…',
    'agentChat.review.addToChat': 'Add to message',
    'agentChat.review.commentOnRange': 'Comment on {{range}}',
    'agentChat.review.noteHeading': 'Review · {{range}}',
    'agentChat.review.addedToChat': 'Added to message',
    'agentChat.review.side.original': 'Old',
    'agentChat.review.side.modified': 'New',

    // Undo toasts
    'agentChat.undo.failedTitle': 'Unable to undo the Agent changes',
    'agentChat.undo.partial': 'Undo stopped partway: some files were already restored.',
    'agentChat.undo.failure': 'Nothing was undone: {{path}} cannot be restored because {{reason}}.',
    'agentChat.undo.failureReason.truncated': 'its diff was too large to keep in full',
    'agentChat.undo.failureReason.changed': 'it changed after the Agent edited it',
    'agentChat.undo.failureReason.missing': 'it no longer exists',
    'agentChat.undo.failureReason.exists': 'it was created again after the Agent deleted it',
    'agentChat.undo.failureReason.renamed':
        'the Agent renamed it, and undoing a rename is not supported yet',
    'agentChat.undo.nextStep.changed':
        'Undo the later turn that edited it first, or use Restore Code to Here on the message that started this turn.',
    'agentChat.undo.successOne': 'Undid the changes to 1 file',
    'agentChat.undo.successOther': 'Undid the changes to {{count}} files',
    'agentChat.redo.failedTitle': 'Unable to redo the Agent changes',
    'agentChat.redo.partial':
        'Redo stopped partway: some files already have the Agent changes again.',
    'agentChat.redo.failure': 'Nothing was redone: {{path}} cannot be restored because {{reason}}.',
    'agentChat.redo.failureReason.changed': 'it changed after the Undo',
    'agentChat.redo.failureReason.missing': 'it no longer exists',
    'agentChat.redo.failureReason.exists': 'it was created again after the Undo',
    'agentChat.redo.successOne': 'Redid the changes to 1 file',
    'agentChat.redo.successOther': 'Redid the changes to {{count}} files',
    'agentChat.redo.unavailable': 'This Undo can no longer be redone.',
    'agentChat.redo.button': 'Redo',
    'agentChat.redo.tooltip': 'Put back the changes this Undo removed',

    // Edit, restore, and fork from a message
    'agentChat.undo.replaceTurnsTitle': 'Replace {{count}} turns?',
    'agentChat.undo.replaceTurnsMessage':
        "Sending this edit removes this message's turn and the {{count}} after it from the conversation. To keep them, cancel and use Fork from Here instead.",
    'agentChat.undo.replaceTurnsConfirm': 'Replace Turns',
    'agentChat.undo.restoringCode': 'Restoring code…',
    'agentChat.undo.restoreSuccessOne': 'Restored the code changed in 1 turn',
    'agentChat.undo.restoreSuccessOther': 'Restored the code changed in {{count}} turns',
    'agentChat.undo.forkSuccess': 'Forked into a new Session',
    'agentChat.undo.forkSuccessNamed': 'Forked into a new Session: {{title}}',

    // Background tasks
    'agentChat.tasks.usageTokens': '{{tokens}} tokens',
    'agentChat.tasks.toolUseOne': '1 tool use',
    'agentChat.tasks.toolUseOther': '{{count}} tool uses',
    'agentChat.tasks.usingTool': 'Using {{tool}}',
    'agentChat.tasks.shell': 'Shell',
    'agentChat.tasks.subagent': 'Subagent',
    'agentChat.tasks.openTask': 'Open {{title}}',
    'agentChat.tasks.stop': 'Stop',
    'agentChat.tasks.stopping': 'Stopping…',
    'agentChat.tasks.stopTask': 'Stop {{title}}',
    'agentChat.tasks.backgroundWork': 'Background work',
    'agentChat.tasks.waiting': 'Waiting',
    'agentChat.tasks.activeCount': '{{count}} active',
    'agentChat.tasks.endedCount': '{{count}} ended',
    'agentChat.tasks.dismissEnded': 'Dismiss ended background work',
    'agentChat.tasks.endedList': 'Ended background work',
    'agentChat.tasks.earlierHidden':
        'Earlier messages are not shown: Chat keeps only the recent part of a long subagent conversation.',
    'agentChat.tasks.emptyRunning': 'The subagent has not reported anything yet.',
    'agentChat.tasks.empty': 'The subagent reported nothing.',
    'agentChat.tasks.unavailable': 'This task is no longer available.',
    'agentChat.tasks.unavailableDetail':
        'The Agent no longer has a record of it, for example after a restart.',
    'agentChat.tasks.loadFailed': 'This task could not be loaded.',
    'agentChat.tasks.showingLatestOutput': 'Showing the latest output',
    'agentChat.tasks.outputCapped': 'Output stopped streaming; the command may still be running',
    'agentChat.tasks.outputLabel': 'Output',
    'agentChat.tasks.noOutputYet': 'No output yet',
    'agentChat.tasks.noOutput': 'No output',
    'agentChat.tasks.loading': 'Loading task…',
} as const;
