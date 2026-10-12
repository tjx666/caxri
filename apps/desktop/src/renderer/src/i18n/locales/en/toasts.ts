/**
 * The toast system: failure sentences built by `describeFailure`, follow-up buttons, and the notification center.
 */
export const toasts = {
    // stores/toasts.ts: describeFailure
    'toasts.failure.withReason': '{{label}}. {{reason}}',
    'toasts.failure.notReady': 'Caxri is not ready yet.',
    'toasts.failure.timedOut': 'Caxri did not respond in time.',
    'toasts.failure.couldNotComplete': 'The operation could not be completed.',
    'toasts.failure.code.VALIDATION': 'The request was not valid.',
    'toasts.failure.code.NOT_FOUND': 'It no longer exists.',
    'toasts.failure.code.PATH_DENIED': 'Access to that location is not allowed.',
    'toasts.failure.code.CAPACITY': 'A limit was reached.',
    'toasts.failure.code.CANCELLED': 'The operation was cancelled.',
    'toasts.failure.code.CONFLICT': 'It conflicts with a newer change. Refresh and try again.',
    'toasts.failure.code.FORBIDDEN': 'This action is not allowed.',
    'toasts.failure.code.IO': 'A file could not be read or written.',
    'toasts.failure.code.GIT': 'The Git operation failed.',
    'toasts.failure.code.INTERNAL': 'An internal error occurred.',
    'toasts.failure.errno.ENOENT': 'The file no longer exists.',
    'toasts.failure.errno.ENOTDIR': 'The path is not a directory.',
    'toasts.failure.errno.EISDIR': 'The path is a directory, not a file.',
    'toasts.failure.errno.EACCES': 'Permission was denied.',
    'toasts.failure.errno.EPERM': 'Permission was denied.',
    'toasts.failure.errno.ENOSPC': 'The disk is full.',
    'toasts.failure.errno.EEXIST': 'A file with that name already exists.',
    'toasts.failure.errno.EPIPE': 'The connection was interrupted.',
    'toasts.failure.errno.ECONNREFUSED': 'The service refused the connection.',
    'toasts.failure.binaryFile': "Binary files can't be opened in the editor.",
    'toasts.muteFailed': 'Unable to mute notifications',

    // stores/toast-actions.ts: follow-up buttons
    'toasts.action.copyDetails': 'Copy details',
    'toasts.action.copyCommand': 'Copy command',
    'toasts.action.restoreDiscardedChanges': 'Restore My Changes',
    'toasts.action.openOnGitHub': 'Open on GitHub',
    'toasts.action.viewDetails': 'View details',
    'toasts.action.undo': 'Undo',
    'toasts.action.redo': 'Redo',
    'toasts.action.openSettings': 'Open Settings',
    'toasts.action.turnOffHardwareAcceleration': 'Turn off hardware acceleration…',
    'toasts.action.stop': 'Stop',
    'toasts.action.showUpdate': 'Show Update',
    'toasts.action.openAgentCommander': 'Open Agent Commander',

    // stores/toast-actions.ts, commands/toast-actions.ts: why a follow-up can no longer run
    'toasts.actionUnavailable.unknown': 'Caxri could not run this action.',
    'toasts.actionUnavailable.missingSession': 'That Session no longer exists.',
    'toasts.actionUnavailable.sessionMovedOn': 'This Session has moved on from that switch.',
    'toasts.copyDetailsFailed': 'Copy details failed',
    'toasts.copyCommandFailed': 'Copy command failed',

    // stores/notifications.ts: mutable notification types
    'toasts.type.worktreeFallback': 'Worktree fallback',
    'toasts.type.agentRecovery': 'Automatic Agent recovery',

    // features/toasts/toast-outlet.tsx
    'toasts.outlet.label': 'Notifications',
    'toasts.outlet.dismiss': 'Dismiss notification',

    // features/toasts/notification-options.tsx
    'toasts.options.label': 'Notification options',
    'toasts.options.mute': "Don't show this type again",
    'toasts.options.muteHint': 'Applies to all Projects. Restore in Settings → Notifications.',

    // features/toasts/notification-center.tsx
    'toasts.center.title': 'Notifications',
    'toasts.center.titleUnread': 'Notifications ({{count}} unread)',
    'toasts.center.occurrences': '{{count}} occurrences',
    'toasts.center.muted': 'Muted',
    'toasts.center.remove': 'Remove notification',
    'toasts.center.clearAll': 'Clear all notifications',
    'toasts.center.settings': 'Notification settings',
    'toasts.center.close': 'Close notifications',
    'toasts.center.empty': 'No recent notifications',
    'toasts.center.list': 'Recent notifications',
    'toasts.center.footer': 'Recent activity from this window. Cleared when the window reloads.',
} as const;
