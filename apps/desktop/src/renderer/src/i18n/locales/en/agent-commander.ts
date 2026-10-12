export const agentCommander = {
    // Window chrome
    'agentCommander.window.title': 'Agent Commander',
    'agentCommander.window.sessionsLabel': 'Sessions',
    'agentCommander.window.stop': 'Stop',
    'agentCommander.window.stopTooltip':
        'Stop the Commander and close this window. Tasks it delegated keep running, and opening it again resumes the same conversation.',
    'agentCommander.window.needsYou': 'Needs you',
    'agentCommander.window.hideNeedsYou': 'Hide Needs you',
    'agentCommander.window.showColumn': 'Show {{column}}',
    'agentCommander.window.hideColumn': 'Hide {{column}}',
    'agentCommander.window.resizeNeedsYou': 'Resize Needs you',

    // Commander Terminal
    'agentCommander.terminal.couldNotStart': 'Agent Commander could not start.',
    'agentCommander.terminal.starting': 'Starting Agent Commander…',
    'agentCommander.terminal.ariaLabel': 'Agent Commander: {{title}}',
    'agentCommander.terminal.startFailed': 'Unable to start Agent Commander',
    'agentCommander.terminal.noLongerSetUp':
        'Agent Commander is no longer set up. Close this window and open it again.',

    // Board
    'agentCommander.board.loadFailed': 'Unable to load the board',
    'agentCommander.board.loading': 'Loading Agents…',
    'agentCommander.board.emptyCommander':
        'No Commander Sessions yet. Describe a goal to the Commander, or hand over Sessions you started, and they appear here.',
    'agentCommander.board.emptyAll':
        'No Sessions yet. Sessions from every Project appear here as their Agents work.',
    'agentCommander.board.scopeLabel': 'Board scope',
    'agentCommander.board.scopeCommander': 'Commander',
    'agentCommander.board.scopeCommanderLabel': 'Sessions the Commander manages',
    'agentCommander.board.scopeAll': 'All',
    'agentCommander.board.scopeAllLabel': 'Every Session',
    'agentCommander.board.group.attention': 'Needs attention',
    'agentCommander.board.group.failed': 'Failed',
    'agentCommander.board.group.finished': 'Recently finished',
    'agentCommander.board.group.idle': 'Idle',
    'agentCommander.board.group.waiting': 'Waiting',
    'agentCommander.board.group.working': 'Working',
    'agentCommander.board.process.exited': 'Exited',
    'agentCommander.board.process.detached': 'Detached',
    'agentCommander.board.process.failed': 'Failed to start',
    'agentCommander.board.process.interrupted': 'Interrupted',
    'agentCommander.board.process.starting': 'Starting',
    'agentCommander.board.process.suspended': 'Suspended',
    'agentCommander.board.noTerminal': 'No Terminal',
    'agentCommander.board.shell': 'Shell',
    'agentCommander.board.unread': 'Unread. {{state}}',
    'agentCommander.board.pullRequestOpen': '{{label}} Open in browser.',
    'agentCommander.board.ownedSession':
        'Created by Agent Commander, so it can delegate tasks here.',
    'agentCommander.board.commanderTask': 'Commander task. {{description}}',

    // Board task status
    'agentCommander.task.label.answered': 'Answered',
    'agentCommander.task.label.blocked': 'Blocked',
    'agentCommander.task.label.failed': 'Failed',
    'agentCommander.task.label.running': 'Running',
    'agentCommander.task.label.starting': 'Starting',
    'agentCommander.task.label.stopped': 'Stopped',
    'agentCommander.task.label.takenOver': 'Taken back by you',
    'agentCommander.task.label.waitingAtStartup': 'Waiting at startup',
    'agentCommander.task.description.answerUnavailable':
        'The Agent finished, but its answer could not be read back.',
    'agentCommander.task.description.awaitingReady':
        'The Agent is starting and has not begun the task yet.',
    'agentCommander.task.description.blocked':
        'The Agent stopped to ask a question, usually one the Commander answers.',
    'agentCommander.task.description.collecting':
        'The Agent finished its turn; the Commander is reading its answer.',
    'agentCommander.task.description.completed':
        'The Agent gave its final answer. The Commander still verifies it before reporting.',
    'agentCommander.task.description.failed': 'The task failed.',
    'agentCommander.task.description.humanIntervened':
        'You typed into this Session while the task ran, so it is yours now. The Commander no longer drives it or sends it follow-ups.',
    'agentCommander.task.description.interrupted': 'The task stopped before the Agent finished.',
    'agentCommander.task.description.launching':
        'The Commander is launching an Agent for this task.',
    'agentCommander.task.description.running': 'The Agent is working on the task.',
    'agentCommander.task.description.submitting': 'The Commander is handing the task to the Agent.',
    'agentCommander.task.waitingAtStartupTitle':
        'Waiting at startup. The Agent is running but has not started, usually on a first-run prompt such as folder trust or sign-in. Open the Session to answer it; the task continues on its own. Task {{delegationId}}.',
    'agentCommander.task.reason': ' Reason: {{reason}}.',
    'agentCommander.task.title': '{{label}}. {{description}}{{reason}} Task {{delegationId}}.',

    // Inbox
    'agentCommander.inbox.hideColumn': 'Hide this column',
    'agentCommander.inbox.loadFailed': 'Unable to load the Inbox',
    'agentCommander.inbox.loading': 'Loading Inbox…',
    'agentCommander.inbox.empty':
        'Nothing needs you. When the Commander has a question or a pull request ready to merge, it appears here.',
    'agentCommander.inbox.section.merge': 'Ready to merge',
    'agentCommander.inbox.section.questions': 'Questions',
    'agentCommander.inbox.openPullRequest': 'Open the pull request in the browser',
    'agentCommander.inbox.showSession': 'Show this Session in the Workbench',
    'agentCommander.inbox.session': 'Session',
    'agentCommander.inbox.answers': 'Answers',
    'agentCommander.inbox.merging': 'Merging…',
    'agentCommander.inbox.merge': 'Merge',
    'agentCommander.inbox.mergeTooltip': 'Merge the commit the Commander verified',
    'agentCommander.inbox.reply': 'Reply',
    'agentCommander.inbox.kind.decision': 'Decision',
    'agentCommander.inbox.kind.hands': 'Needs you',
    'agentCommander.inbox.kind.merge': 'Pull request',
    'agentCommander.inbox.replyState.read': 'Read by Commander',
    'agentCommander.inbox.replyState.delivered': 'Delivered to Commander',

    // Inbox merge readiness
    'agentCommander.mergeState.changedSinceVerified': 'Changed since verified',
    'agentCommander.mergeState.changedSinceVerifiedReason':
        'New commits landed after the Commander verified this pull request. It re-verifies before you merge.',
    'agentCommander.mergeState.draft': 'Draft',
    'agentCommander.mergeState.draftReason': 'The pull request is still a draft.',
    'agentCommander.mergeState.conflicts': 'Conflicts',
    'agentCommander.mergeState.conflictsReason': 'The pull request conflicts with its base branch.',
    'agentCommander.mergeState.unknown': 'GitHub state unknown',
    'agentCommander.mergeState.checksFailing': 'Checks failing',
    'agentCommander.mergeState.checksRunning': 'Checks running',
    'agentCommander.mergeState.blocked': 'Blocked',
    'agentCommander.mergeState.behindBase': 'Behind base',
    'agentCommander.mergeState.checksPassed': 'Checks passed',

    // Inbox composer
    'agentCommander.composer.suggestionFooter': '↑↓ to move · Enter to choose',
    'agentCommander.composer.suggestionLabel': 'Inbox items',
    'agentCommander.composer.replyingTo': 'Replying to',
    'agentCommander.composer.clearTarget': 'Clear the reply target',
    'agentCommander.composer.mentionHint': 'Type @ to choose the item you are answering.',
    'agentCommander.composer.inputLabel': 'Reply to the Commander',
    'agentCommander.composer.placeholderWithTarget': 'Your answer',
    'agentCommander.composer.placeholder': '@ an item, then your answer',
    'agentCommander.composer.sendTooltip': 'Send (Enter)',
    'agentCommander.composer.sendLabel': 'Send reply',

    // Inbox commands
    'agentCommander.inboxCommands.replyFailed': 'Unable to send the reply',
    'agentCommander.inboxCommands.dismissTitle': 'Dismiss this item?',
    'agentCommander.inboxCommands.dismissMergeMessage':
        'The Commander is told you will not merge this pull request from the Inbox. The pull request itself stays open.',
    'agentCommander.inboxCommands.dismissQuestionMessage':
        'The Commander is told you dismissed this question without an answer.',
    'agentCommander.inboxCommands.dismissFailed': 'Unable to dismiss this item',
    'agentCommander.inboxCommands.mergeTitle': 'Merge {{pullRequest}}?',
    'agentCommander.inboxCommands.mergeMessage':
        "Merges commit {{sha}}, the one the Commander verified, with the repository's preferred merge method. GitHub refuses if new commits landed.",
    'agentCommander.inboxCommands.mergeFailed': 'Unable to merge this pull request',
    'agentCommander.inboxCommands.merged': 'Merged {{pullRequest}}',

    // Commander commands
    'agentCommander.commands.revealFailed': 'Unable to show this Session in the Workbench',
    'agentCommander.commands.openSettingsFailed': 'Unable to open Settings in the Workbench',
    'agentCommander.commands.stopFailed': 'Unable to stop Agent Commander',
    'agentCommander.commands.stopAndClose': 'Stop and Close',
    'agentCommander.commands.stopOutcome':
        'Stopping the Commander ends the current turn and closes this window. Tasks it delegated keep running.',
    'agentCommander.commands.stopTurnTitle': 'Stop the running turn?',
    'agentCommander.commands.stopTurnMessage':
        'Agent Commander is still working. Stopping it ends the current turn and closes its window. Tasks it delegated keep running.',
    // Hand-over
    'agentCommander.handover.open': 'Hand Over',
    'agentCommander.handover.openEllipsis': 'Hand Over…',
    'agentCommander.handover.openTooltip':
        'Hand your own Sessions, or Agent conversations started outside Caxri, to the Commander',
    'agentCommander.handover.title': 'Hand Over to Agent Commander',
    'agentCommander.handover.description':
        'The Commander takes over what you pick and continues each Agent conversation where it stopped. Your note tells it what to do.',
    'agentCommander.handover.sourceLabel': 'What to hand over',
    'agentCommander.handover.sessionsTab': 'Sessions',
    'agentCommander.handover.conversationsTab': 'Outside Caxri',
    'agentCommander.handover.searchSessions': 'Search Sessions or Projects',
    'agentCommander.handover.searchConversations': 'Search conversations or folders',
    'agentCommander.handover.loadingSessions': 'Loading Sessions…',
    'agentCommander.handover.loadingConversations':
        'Looking for Claude Code, Codex, and Grok Build conversations…',
    'agentCommander.handover.loadFailed': 'Unable to load this list.',
    'agentCommander.handover.noMatches': 'Nothing matches your search.',
    'agentCommander.handover.noSessions': 'Every Session is already with the Commander.',
    'agentCommander.handover.noConversations':
        'No Agent conversations from the last 30 days were found outside Caxri.',
    'agentCommander.handover.selectGroup': 'Select all in {{group}}',
    'agentCommander.handover.selectCandidate': 'Select {{title}}',
    'agentCommander.handover.addsProject': 'Adds this folder as a Project',
    'agentCommander.handover.mayBeOpen': 'May be open elsewhere',
    'agentCommander.handover.mayBeOpenWarning':
        'A conversation you picked was active in the last few minutes. If it is still open in another terminal, both copies will continue separately.',
    'agentCommander.handover.tooMany':
        'Hand over at most {{max}} at once. Deselect {{excess}} to continue.',
    'agentCommander.handover.untitledConversation': 'Untitled conversation',
    'agentCommander.handover.refusedReason': 'Not handed over: {{reason}}',
    'agentCommander.handover.noteLabel': 'Note for the Commander',
    'agentCommander.handover.notePlaceholder':
        'Optional: what the Commander should do, for example "finish the migration and open a pull request"',
    'agentCommander.handover.takeBackHint': 'Typing into a handed-over Session takes it back.',
    'agentCommander.handover.selectedCount': '{{count}} selected',
    'agentCommander.handover.submit': 'Hand Over',
    'agentCommander.handover.submitting': 'Handing over…',
    'agentCommander.handover.failed': 'Unable to hand over to Agent Commander',
    'agentCommander.handover.noneAccepted': 'Nothing was handed over: {{reason}}',
    'agentCommander.handover.partlyAccepted':
        'Handed {{accepted}} to Agent Commander; {{refused}} could not be handed over',
    'agentCommander.handover.acceptedOne': 'Handed 1 Session to Agent Commander',
    'agentCommander.handover.acceptedOther': 'Handed {{count}} Sessions to Agent Commander',
    'agentCommander.handover.takeBackFailed': 'Unable to take the Session back',
    'agentCommander.handover.takenBack': 'Took the Session back from Agent Commander',
    'agentCommander.handover.takenBackByInput': 'Took {{title}} back from Agent Commander',
    'agentCommander.handover.takenBackByInputUntitled': 'Took a Session back from Agent Commander',
    'agentCommander.handover.rejection.alreadyManaged': 'the Commander already manages it',
    'agentCommander.handover.rejection.commanderSession': 'it is the Commander itself',
    'agentCommander.handover.rejection.commanderUnavailable': 'Agent Commander is not set up',
    'agentCommander.handover.rejection.conversationBound':
        'a Caxri Terminal already has this conversation',
    'agentCommander.handover.rejection.conversationMissing':
        'the conversation or its folder no longer exists',
    'agentCommander.handover.rejection.duplicate': 'it was picked twice',
    'agentCommander.handover.rejection.ownershipCapacity':
        'the Commander manages too many Sessions',
    'agentCommander.handover.rejection.projectUnavailable': 'its Project is hidden or unavailable',
    'agentCommander.handover.rejection.sessionArchived': 'the Session is archived',
    'agentCommander.handover.rejection.sessionMissing': 'the Session no longer exists',
    'agentCommander.handover.rejection.taskCapacity': 'the Commander has too many open tasks',
    'agentCommander.board.handoverContinuable':
        'Handed over by you. The Commander continues this conversation once its Agent is between turns.',
    'agentCommander.board.handoverOwnershipOnly':
        'Handed over by you. There is no Agent conversation to continue, so the Commander starts new work here.',

    // Workbench Session row marker
    'agentCommander.sessionMarker.managed': 'Managed by Agent Commander',
    'agentCommander.sessionMarker.inputTakesBack':
        'Managed by Agent Commander · typing here takes it back',
} as const;
