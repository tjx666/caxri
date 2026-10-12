/**
 * Session creation, switching, archive management, content search, and Session lifecycle toasts (`features/session/`).
 */
export const session = {
    'session.unknownProject': 'Unknown Project',

    // Session creation menu and dialog
    'session.create.newSession': 'New Session',
    'session.create.newInProject': 'New Session in {{project}}',
    'session.create.actionInProject': '{{action}} in {{project}}',
    'session.create.withoutTerminal': 'Start without a Terminal',
    'session.createDialog.title': 'Choose the default Terminal',
    'session.createDialog.description':
        'Create a Session. Its primary Agent Terminal provides the Session title when metadata is available.',
    'session.createDialog.descriptionInProject':
        'Create a Session in {{project}}. Its primary Agent Terminal provides the Session title when metadata is available.',
    'session.openInChat.label': 'Always Open Agents in Chat',
    'session.openInChat.failed': 'Unable to change how Agents open',

    // Recently used Sessions switcher
    'session.mru.title': 'Recently used Sessions',
    'session.mru.selectedStatus': 'Selected {{title}}, {{position}} of {{total}}',
    'session.mru.release': 'Release',
    'session.mru.toSwitch': 'to switch',

    // Archived Sessions dialog
    'session.archived.title': 'Archived Sessions',
    'session.archived.description':
        'Search and manage archived work across every Project. Restoring a Session does not start its Terminal.',
    'session.archived.searchPlaceholder': 'Search Session titles',
    'session.archived.projectFilter': 'Project',
    'session.archived.filterByProject': 'Filter by Project',
    'session.archived.allProjects': 'All Projects',
    'session.archived.agentFilter': 'Agent',
    'session.archived.filterByAgent': 'Filter by Agent',
    'session.archived.allAgents': 'All Agents',
    'session.archived.selectAllVisible': 'Select all visible archived Sessions',
    'session.archived.selectAll': 'Select all',
    'session.archived.selectUntitled': 'Select Untitled',
    'session.archived.deselectUntitled': 'Deselect Untitled',
    'session.archived.selectedCount': '{{count}} selected',
    'session.archived.restoreSelected': 'Restore Selected',
    'session.archived.deleteSelected': 'Delete Selected',
    'session.archived.selectSession': 'Select {{title}}',
    'session.archived.archivedAt': 'Archived {{time}}',
    'session.archived.restoreSession': 'Restore {{title}}',
    'session.archived.deleteSession': 'Delete {{title}}',
    'session.archived.selectAllInProject': 'Select all archived Sessions in {{project}}',
    'session.archived.noMatches': 'No archived Sessions match these filters',
    'session.archived.clearFilters': 'Clear Filters',
    'session.archived.emptyTitle': 'No archived Sessions yet',
    'session.archived.emptyDescription':
        'Archived Sessions will remain available here for restoration or deletion.',
    'session.archived.countOne': '{{count}} archived Session',
    'session.archived.countOther': '{{count}} archived Sessions',
    'session.archived.matchingCount': '{{matching}} of {{total}} archived Sessions',

    // Session content search
    'session.contentSearch.title': 'Search Session Content',
    'session.contentSearch.description':
        'Search user and assistant messages across active and archived Sessions. Tool output is excluded.',
    'session.contentSearch.placeholder': 'Search conversation text…',
    'session.contentSearch.prompt': 'Enter text to find a conversation.',
    'session.contentSearch.searching': 'Searching Sessions…',
    'session.contentSearch.failed': 'Could not search Session content.',
    'session.contentSearch.retrySearch': 'Retry search',
    'session.contentSearch.noMatchesPartial': 'No matches in the searched content.',
    'session.contentSearch.noMatches': 'No matching Sessions.',
    'session.contentSearch.results': 'Session content results',
    'session.contentSearch.archivedResult': 'Archived · View in Archived Sessions',
    'session.contentSearch.activeResult': 'Active · Open Session',
    'session.contentSearch.coverage': 'Searched {{scanned}} of {{total}} Sessions',
    'session.contentSearch.unavailable': '; {{count}} without readable conversation data',
    'session.contentSearch.budgetLimit': '; search limit reached — retry to search again',
    'session.contentSearch.resultLimit': '; result limit reached — narrow your query',
    'session.contentSearch.skipped':
        '; some conversation content was skipped or exceeded scan limits',
    'session.contentSearch.partial': 'Partial results · {{coverage}}',

    // Archive and restore notices
    'session.notice.archived': 'Archived "{{title}}"',
    'session.notice.archivedUntitled': 'Archived Session',
    'session.notice.restored': 'Restored "{{title}}"',
    'session.notice.restoredUntitled': 'Restored Session',
    'session.notice.restoredCount': 'Restored {{count}} Sessions',
    'session.notice.undoArchive': 'Undo archiving {{title}}',

    // Agent detach, resume, and identifiers
    'session.detach.confirm': 'Stop and Detach',
    'session.detach.outcome':
        'Detaching stops the current turn so another client can resume this conversation.',
    'session.agent.conversationIdCopied': 'Conversation ID copied',
    'session.agent.noTranscript': 'This Agent keeps no on-disk transcript',
    'session.rename.noConversation': 'This Session has no Agent conversation to name it from.',

    // Warm-cache compaction
    'session.compaction.progress': 'Checking Sessions for warm-cache compaction…',
    'session.compaction.failed': 'Batch compaction failed',
    'session.compaction.requestedOne': 'Compaction requested for {{count}} Session.',
    'session.compaction.requestedOther': 'Compaction requested for {{count}} Sessions.',
    'session.compaction.noneEligible': 'No Sessions were eligible for compaction.',
    'session.compaction.withSkipped': '{{headline}} Skipped: {{details}}.',
    'session.compaction.detailSeparator': '; ',
    'session.compaction.deferred': '{{count}} beyond the 200-Session batch limit',
    'session.compaction.outcome.submitted': '{{count}} submitted',
    'session.compaction.outcome.unsupported': '{{count}} unsupported Agent',
    'session.compaction.outcome.not_running': '{{count}} Agent stopped',
    'session.compaction.outcome.busy': '{{count}} busy or compacting',
    'session.compaction.outcome.unsafe_input': '{{count}} draft or idle state unverified',
    'session.compaction.outcome.usage_unavailable': '{{count}} usage unavailable',
    'session.compaction.outcome.already_compacted': '{{count}} already compacted',
    'session.compaction.outcome.cache_expired': '{{count}} cache estimated expired',
    'session.compaction.outcome.changed': '{{count}} state changed',
    'session.compaction.outcome.failed': '{{count}} delivery failed',
    'session.compaction.outcome.delivery_unknown': '{{count}} delivery unconfirmed',

    // Command failure toasts
    'session.errors.selectFailed': 'Session selection failed',
    'session.errors.reorderProjectFailed': 'Project reordering failed',
    'session.errors.reorderSessionFailed': 'Session reordering failed',
    'session.errors.reorderPinnedFailed': 'Pinned Session reordering failed',
    'session.errors.pinFailed': 'Pin Session failed',
    'session.errors.unpinFailed': 'Unpin Session failed',
    'session.errors.renameFailed': 'Session rename failed',
    'session.errors.openInEditorFailed': 'Opening the Project in the external editor failed',
    'session.errors.deleteFailed': 'Session deletion failed',
    'session.errors.moveToNewSessionFailed': 'Move to new session failed',
    'session.errors.archiveFailed': 'Session archive failed',
    'session.errors.restoreFailed': 'Session restore failed',
    'session.errors.createFailed': 'Session creation failed',
    'session.errors.createProjectFailed': 'Project creation failed',
    'session.errors.selectFolderFailed': 'Project folder selection failed',
    'session.errors.detachFailed': 'Session detach failed',
    'session.errors.resumeFailed': 'Session resume failed',
    'session.errors.copyConversationIdFailed': 'Unable to copy the conversation ID',
    'session.errors.copyTranscriptPathFailed': 'Unable to copy the transcript path',
    'session.errors.deleteProjectFailed': 'Project deletion failed',
    'session.errors.hideProjectFailed': 'Project could not be hidden',
    'session.errors.referenceFailed': "Couldn't reference that Session",
    'session.errors.suggestTitleFailed': "Couldn't name this Session",
    'session.errors.revokeAutoAllowFailed': 'Turning off Always Allow failed',
} as const;
