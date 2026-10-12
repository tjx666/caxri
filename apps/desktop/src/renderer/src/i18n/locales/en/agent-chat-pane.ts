/**
 * Agent Chat pane chrome: the recovery banner, the activity row, command failure toasts, and the user message menu.
 */
export const agentChatPane = {
    'agentChat.pane.filesUnsupported':
        '{{provider}} cannot restore files; only the conversation rewinds',
    'agentChat.dock.openAsTerminal': 'Open as Terminal',
    'agentChat.dock.resume': 'Resume',
    'agentChat.activity.enterHint': 'to queue',
    'agentChat.activity.steerHint': 'to steer',
    'agentChat.activity.stopHint': 'to stop',
    'agentChat.commands.sendFailed': 'Message could not be sent',
    'agentChat.commands.longPasteFailed': "Long paste couldn't be saved",
    'agentChat.commands.editFailed': 'Message could not be edited',
    'agentChat.commands.forkFailed': 'Conversation could not be forked',
    'agentChat.commands.restoreFailed': 'Code could not be restored',
    'agentChat.commands.runCommandFailed': '/{{name}} could not run',
    'agentChat.commands.stopAgentFailed': 'Unable to stop the Agent',
    'agentChat.commands.answerFailed': 'Unable to answer the Agent',
    'agentChat.commands.saveProjectDefaultFailed': 'Unable to save the Project default',
    'agentChat.commands.stopTaskFailed': 'Unable to stop the task',
    'agentChat.commands.removeQueuedFailed': 'Unable to remove the queued message',
    'agentChat.commands.editQueuedFailed': 'Unable to edit the queued message',
    'agentChat.commands.sendQueuedFailed': 'Unable to send the queued message',
    'agentChat.commands.resumeQueueFailed': 'Unable to resume the queue',
    'agentChat.commands.findTranscriptFailed': 'Unable to find the transcript',
    'agentChat.commands.noTranscript':
        'This Chat has no transcript on disk for a new Chat to read.',
    'agentChat.userMenu.copyMessage': 'Copy Message',
    'agentChat.userMenu.editFromHere': 'Edit from Here',
    'agentChat.userMenu.forkFromHere': 'Fork from Here',
    'agentChat.userMenu.restoreCodeToHere': 'Restore Code to Here',
    'agentChat.userMenu.forkOpening': 'A fork from this message is already opening',
    'agentChat.userMenu.copyFailed': 'Unable to copy the message',
    'agentChat.userMenu.selectionCopied': 'Selection copied',
    'agentChat.userMenu.messageCopied': 'Message copied',
    'agentChat.history.loadFailed': 'Earlier messages could not be loaded.',
    'agentChat.history.loading': 'Loading earlier messages…',
    'agentChat.history.unavailable':
        'Earlier messages are not available in Chat. {{provider}} still has all of them.',
} as const;
