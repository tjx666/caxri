export const caxriBot = {
    // Window chrome
    'caxriBot.window.title': 'Caxri Bot',
    'caxriBot.window.sessionsLabel': 'Sessions',
    'caxriBot.window.stop': 'Stop Caxri Bot',
    'caxriBot.window.more': 'More',
    'caxriBot.window.commandPalette': 'Command Palette…',
    'caxriBot.window.needsYou': 'Needs you',
    'caxriBot.window.hideNeedsYou': 'Hide Needs you',
    'caxriBot.window.showColumn': 'Show {{column}}',
    'caxriBot.window.hideColumn': 'Hide {{column}}',
    'caxriBot.window.resizeNeedsYou': 'Resize Needs you',
    'caxriBot.window.resizeSessions': 'Resize Sessions',

    // Caxri Bot's Agent
    'caxriBot.agent.label': "Caxri Bot's Agent: {{agent}}",
    'caxriBot.agent.tooltip': 'Caxri Bot runs on {{agent}}. Click to switch.',
    'caxriBot.agent.menuLabel': 'Run Caxri Bot on',
    'caxriBot.agent.switchTitle': 'Switch Caxri Bot to {{agent}}?',
    'caxriBot.agent.switchMessage':
        'Caxri Bot starts a new conversation on {{agent}}. Its tasks, memory, and Needs you items stay, and tasks it delegated keep running.',
    'caxriBot.agent.switchConfirm': 'Switch to {{agent}}',
    'caxriBot.agent.switchFailed': 'Unable to switch Caxri Bot to {{agent}}',

    // Command Palette
    'caxriBot.palette.placeholder': 'Type a command or a Session',
    'caxriBot.palette.empty': 'No command or Session found.',
    'caxriBot.palette.group.bot': 'Caxri Bot',
    'caxriBot.palette.group.view': 'View',
    'caxriBot.palette.group.agent': 'Agent',
    'caxriBot.palette.switchAgent': 'Switch Caxri Bot to {{agent}}',
    'caxriBot.palette.switchAgentKeywords': 'agent model provider change run on',
    'caxriBot.palette.handover': 'Hand Over to Caxri Bot…',
    'caxriBot.palette.handoverKeywords': 'handover delegate sessions conversations import',
    'caxriBot.palette.clearData': 'Clear Caxri Bot Data…',
    'caxriBot.palette.clearDataKeywords':
        'clear delete reset forget memory tasks agents.md instructions cleanup',
    'caxriBot.palette.openSettings': 'Open Settings',
    'caxriBot.palette.stopKeywords': 'quit close exit stop',
    'caxriBot.palette.boardKeywords': 'board sidebar sessions column',
    'caxriBot.palette.showBotSessions': 'Show Only Caxri Bot Sessions',
    'caxriBot.palette.showAllSessions': 'Show Every Session',
    'caxriBot.palette.inboxKeywords': 'inbox needs you questions pull requests column',

    // Clear Caxri Bot Data
    'caxriBot.clearData.title': 'Clear Caxri Bot Data',
    'caxriBot.clearData.description':
        'Pick what Caxri Bot should forget. Sessions, their Terminals, and your repositories are never touched.',
    'caxriBot.clearData.loadFailed': 'Unable to read what Caxri Bot keeps.',
    'caxriBot.clearData.loading': 'Reading what Caxri Bot keeps…',
    'caxriBot.clearData.tasks': 'Tasks',
    'caxriBot.clearData.tasksDescription':
        'The task ledger Caxri Bot tracks delegated work with. A deleted open task stops being followed up.',
    'caxriBot.clearData.tasksMeta': '{{open}} open · {{closed}} finished',
    'caxriBot.clearData.taskChoiceLabel': 'Which tasks',
    'caxriBot.clearData.taskChoiceClosed': 'Finished',
    'caxriBot.clearData.taskChoiceAll': 'All',
    'caxriBot.clearData.taskChoiceChosen': 'Choose…',
    'caxriBot.clearData.olderTasks':
        '{{count}} older tasks are not listed; choose Finished or All to include them.',
    'caxriBot.clearData.olderTasksOne':
        '1 older task is not listed; choose Finished or All to include it.',
    'caxriBot.clearData.taskStatus.pending': 'Pending',
    'caxriBot.clearData.taskStatus.dispatched': 'Delegated',
    'caxriBot.clearData.taskStatus.waiting_user': 'Waiting for you',
    'caxriBot.clearData.taskStatus.done': 'Done',
    'caxriBot.clearData.taskStatus.dropped': 'Dropped',
    'caxriBot.clearData.taskFiles': 'Task files',
    'caxriBot.clearData.taskFilesDescription':
        'Task briefs and pull request reports Caxri Bot saved beside its tasks.',
    'caxriBot.clearData.taskFilesMeta': '{{count}} files · {{size}}',
    'caxriBot.clearData.taskFilesMetaOne': '1 file · {{size}}',
    'caxriBot.clearData.inboxDescription':
        'Questions and pull requests waiting for you, and the ones already answered.',
    'caxriBot.clearData.inboxMeta': '{{open}} open · {{closed}} closed',
    'caxriBot.clearData.memory': 'Memory',
    'caxriBot.clearData.memoryDescription':
        'What Caxri Bot learned about you and your Projects goes back to the starting template.',
    'caxriBot.clearData.memoryLearned': 'Learned notes',
    'caxriBot.clearData.memoryEmpty': 'Nothing learned yet',
    'caxriBot.clearData.instructions': 'Instructions',
    'caxriBot.clearData.instructionsDescription':
        'Rewrite AGENTS.md from the current template, dropping any edits made to it.',
    'caxriBot.clearData.instructionsWithMemory':
        'Rewritten with the memory reset, since AGENTS.md carries the memory.',
    'caxriBot.clearData.conversation': 'Conversation',
    'caxriBot.clearData.conversationDescription':
        'Start a new {{agent}} conversation, so nothing from the current one carries over.',
    'caxriBot.clearData.conversationNone': 'Not started',
    'caxriBot.clearData.stillInConversation':
        '{{agent}} has already read the old memory and instructions in this conversation. Tick Conversation to start fresh.',
    'caxriBot.clearData.submit': 'Clear Data',
    'caxriBot.clearData.failed': 'Unable to clear Caxri Bot data',
    'caxriBot.clearData.outcome.tasks': '{{count}} tasks',
    'caxriBot.clearData.outcome.tasksOne': '1 task',
    'caxriBot.clearData.outcome.files': '{{count}} task files',
    'caxriBot.clearData.outcome.filesOne': '1 task file',
    'caxriBot.clearData.outcome.inbox': '{{count}} Needs you items',
    'caxriBot.clearData.outcome.inboxOne': '1 Needs you item',
    'caxriBot.clearData.outcome.memory': 'the memory',
    'caxriBot.clearData.outcome.instructions': 'the instructions',
    'caxriBot.clearData.outcome.conversation': 'the conversation',
    'caxriBot.clearData.outcome.separator': ', ',
    'caxriBot.clearData.outcome.summary': 'Cleared {{parts}}',
    'caxriBot.clearData.outcome.nothing': 'There was nothing left to clear',

    // First start
    'caxriBot.start.title': 'Start Caxri Bot',
    'caxriBot.start.description':
        'Describe a goal and Caxri Bot breaks it into tasks, starts a coding Agent for each one in a visible Session, and reports back.',
    'caxriBot.start.agentLabel': 'Agent',
    'caxriBot.start.permissionsLabel': 'Permissions',
    'caxriBot.start.permissions':
        'Full access: Caxri Bot and the Agents it starts edit files and run commands without asking.',
    'caxriBot.start.surfaceLabel': 'Runs in',
    'caxriBot.start.surface': 'A Terminal. Switch it to Chat from the title bar once it starts.',
    'caxriBot.start.backgroundLabel': 'Window',
    'caxriBot.start.background':
        'Closing this window keeps Caxri Bot and its Agents running. Stop it from More > Stop Caxri Bot.',
    'caxriBot.start.action': 'Start Caxri Bot',

    // Caxri Bot Terminal
    'caxriBot.terminal.couldNotStart': 'Caxri Bot could not start.',
    'caxriBot.terminal.couldNotStartHint':
        'Try again. If it keeps failing, the details below say what went wrong.',
    'caxriBot.terminal.failureDetail': 'Details: {{message}}',
    'caxriBot.terminal.starting': 'Starting Caxri Bot…',
    'caxriBot.terminal.ariaLabel': 'Caxri Bot: {{title}}',
    'caxriBot.terminal.startFailed': 'Unable to start Caxri Bot',
    'caxriBot.terminal.noLongerSetUp':
        'Caxri Bot is no longer set up. Close this window and open it again.',

    // Board
    'caxriBot.board.loadFailed': 'Unable to load the board',
    'caxriBot.board.loading': 'Loading Agents…',
    'caxriBot.board.emptyBot':
        'Caxri Bot has no Sessions yet. Describe a goal to it, or hand over Sessions you started, and they appear here.',
    'caxriBot.board.emptyAll':
        'No Sessions yet. Sessions from every Project appear here as their Agents work.',
    'caxriBot.board.scopeLabel': 'Board scope',
    'caxriBot.board.scopeBot': 'Caxri Bot',
    'caxriBot.board.scopeBotLabel': 'Caxri Bot ({{count}}): Sessions Caxri Bot manages',
    'caxriBot.board.scopeAll': 'All',
    'caxriBot.board.scopeAllLabel': 'All ({{count}}): every Session',
    'caxriBot.board.group.attention': 'Needs attention',
    'caxriBot.board.group.failed': 'Failed',
    'caxriBot.board.group.finished': 'Recently finished',
    'caxriBot.board.group.idle': 'Idle',
    'caxriBot.board.group.waiting': 'Waiting',
    'caxriBot.board.group.working': 'Working',
    'caxriBot.board.process.exited': 'Exited',
    'caxriBot.board.process.detached': 'Detached',
    'caxriBot.board.process.failed': 'Failed to start',
    'caxriBot.board.process.interrupted': 'Interrupted',
    'caxriBot.board.process.starting': 'Starting',
    'caxriBot.board.process.suspended': 'Suspended',
    'caxriBot.board.noTerminal': 'No Terminal',
    'caxriBot.board.shell': 'Shell',
    'caxriBot.board.unread': 'Unread. {{state}}',
    'caxriBot.board.pullRequestOpen': '{{label}} Open in browser.',
    'caxriBot.board.ownedSession': 'Created by Caxri Bot, so it can delegate tasks here.',
    'caxriBot.board.botTask': 'Caxri Bot task. {{description}}',

    // Board task status
    'caxriBot.task.label.answered': 'Answered',
    'caxriBot.task.label.blocked': 'Blocked',
    'caxriBot.task.label.failed': 'Failed',
    'caxriBot.task.label.running': 'Running',
    'caxriBot.task.label.starting': 'Starting',
    'caxriBot.task.label.stopped': 'Stopped',
    'caxriBot.task.label.takenOver': 'Taken back by you',
    'caxriBot.task.label.waitingAtStartup': 'Waiting at startup',
    'caxriBot.task.description.answerUnavailable':
        'The Agent finished, but its answer could not be read back.',
    'caxriBot.task.description.awaitingReady':
        'The Agent is starting and has not begun the task yet.',
    'caxriBot.task.description.blocked':
        'The Agent stopped to ask a question, usually one Caxri Bot answers.',
    'caxriBot.task.description.collecting':
        'The Agent finished its turn; Caxri Bot is reading its answer.',
    'caxriBot.task.description.completed':
        'The Agent gave its final answer. Caxri Bot still verifies it before reporting.',
    'caxriBot.task.description.failed': 'The task failed.',
    'caxriBot.task.description.humanIntervened':
        'You typed into this Session while the task ran, so it is yours now. Caxri Bot no longer drives it or sends it follow-ups.',
    'caxriBot.task.description.interrupted': 'The task stopped before the Agent finished.',
    'caxriBot.task.description.launching': 'Caxri Bot is launching an Agent for this task.',
    'caxriBot.task.description.running': 'The Agent is working on the task.',
    'caxriBot.task.description.submitting': 'Caxri Bot is handing the task to the Agent.',
    'caxriBot.task.waitingAtStartupTitle':
        'Waiting at startup. The Agent is running but has not started, usually on a first-run prompt such as folder trust or sign-in. Open the Session to answer it; the task continues on its own.',
    'caxriBot.task.reason': ' Reason: {{reason}}.',
    'caxriBot.task.title': '{{label}}. {{description}}{{reason}}',

    // Inbox
    'caxriBot.inbox.loadFailed': 'Unable to load the Inbox',
    'caxriBot.inbox.loading': 'Loading Inbox…',
    'caxriBot.inbox.empty':
        'Nothing needs you. When Caxri Bot has a question or a pull request ready to merge, it appears here.',
    'caxriBot.inbox.section.merge': 'Ready to merge',
    'caxriBot.inbox.section.questions': 'Questions',
    'caxriBot.inbox.openPullRequest': 'Open the pull request in the browser',
    'caxriBot.inbox.showSession': 'Show this Session in the Workbench',
    'caxriBot.inbox.session': 'Session',
    'caxriBot.inbox.answers': 'Answers',
    'caxriBot.inbox.merging': 'Merging…',
    'caxriBot.inbox.merge': 'Merge',
    'caxriBot.inbox.mergeTooltip': 'Merge the commit Caxri Bot verified',
    'caxriBot.inbox.reply': 'Reply',

    // Inbox merge readiness
    'caxriBot.mergeState.changedSinceVerified': 'Changed since verified',
    'caxriBot.mergeState.changedSinceVerifiedReason':
        'New commits landed after Caxri Bot verified this pull request. It re-verifies before you merge.',
    'caxriBot.mergeState.draft': 'Draft',
    'caxriBot.mergeState.draftReason': 'The pull request is still a draft.',
    'caxriBot.mergeState.conflicts': 'Conflicts',
    'caxriBot.mergeState.conflictsReason': 'The pull request conflicts with its base branch.',
    'caxriBot.mergeState.unknown': 'GitHub state unknown',
    'caxriBot.mergeState.checksFailing': 'Checks failing',
    'caxriBot.mergeState.checksRunning': 'Checks running',
    'caxriBot.mergeState.blocked': 'Blocked',
    'caxriBot.mergeState.behindBase': 'Behind base',
    'caxriBot.mergeState.checksPassed': 'Checks passed',

    // Inbox composer
    'caxriBot.composer.suggestionLabel': 'Inbox items',
    'caxriBot.composer.replyingTo': 'Replying to',
    'caxriBot.composer.clearTarget': 'Clear the reply target',
    'caxriBot.composer.mentionHint': 'Type @ to choose the item you are answering.',
    'caxriBot.composer.inputLabel': 'Reply to Caxri Bot',
    'caxriBot.composer.placeholderWithTarget': 'Your answer',
    'caxriBot.composer.placeholder': '@ an item, then your answer',
    'caxriBot.composer.sendTooltip': 'Send (Enter)',
    'caxriBot.composer.sendNeedsTarget': 'Choose an item with @ first',
    'caxriBot.composer.sendNeedsText': 'Type a reply',
    'caxriBot.composer.sendLabel': 'Send reply',

    // Inbox commands
    'caxriBot.inboxCommands.replyFailed': 'Unable to send the reply',
    'caxriBot.inboxCommands.dismissed': 'Dismissed',
    'caxriBot.inboxCommands.dismissUndoExpired': 'This Dismiss can no longer be undone',
    'caxriBot.inboxCommands.dismissFailed': 'Unable to dismiss this item',
    'caxriBot.inboxCommands.mergeTitle': 'Merge {{pullRequest}}?',
    'caxriBot.inboxCommands.mergeMessage':
        "Merges commit {{sha}}, the one Caxri Bot verified, with the repository's preferred merge method. GitHub refuses if new commits landed.",
    'caxriBot.inboxCommands.mergeFailed': 'Unable to merge this pull request',
    'caxriBot.inboxCommands.merged': 'Merged {{pullRequest}}',

    // Caxri Bot commands
    'caxriBot.commands.revealFailed': 'Unable to show this Session in the Workbench',
    'caxriBot.commands.openSettingsFailed': 'Unable to open Settings in the Workbench',
    'caxriBot.commands.stopFailed': 'Unable to stop Caxri Bot',
    'caxriBot.commands.stopAndClose': 'Stop and Close',
    'caxriBot.commands.stopOutcome':
        'Stopping Caxri Bot ends the current turn and closes this window. Tasks it delegated keep running.',
    'caxriBot.commands.stopTurnTitle': 'Stop the running turn?',
    'caxriBot.commands.stopTurnMessage':
        'Caxri Bot is still working. Stopping it ends the current turn and closes its window. Tasks it delegated keep running.',
    // Hand-over
    'caxriBot.handover.openEllipsis': 'Hand Over…',
    'caxriBot.handover.openTooltip':
        'Hand your own Sessions, or Agent conversations started outside Caxri, to Caxri Bot',
    'caxriBot.handover.title': 'Hand Over to Caxri Bot',
    'caxriBot.handover.description':
        'Caxri Bot takes over what you pick and continues each Agent conversation where it stopped. Your note tells it what to do.',
    'caxriBot.handover.sourceLabel': 'What to hand over',
    'caxriBot.handover.sessionsTab': 'Sessions',
    'caxriBot.handover.conversationsTab': 'Outside Caxri',
    'caxriBot.handover.searchSessions': 'Search Sessions or Projects',
    'caxriBot.handover.searchConversations': 'Search conversations or folders',
    'caxriBot.handover.loadingSessions': 'Loading Sessions…',
    'caxriBot.handover.loadingConversations':
        'Looking for Claude Code, Codex, and Grok Build conversations…',
    'caxriBot.handover.loadFailed': 'Unable to load this list.',
    'caxriBot.handover.noMatches': 'Nothing matches your search.',
    'caxriBot.handover.noSessions': 'Every Session is already with Caxri Bot.',
    'caxriBot.handover.noConversations':
        'No Agent conversations from the last 30 days were found outside Caxri.',
    'caxriBot.handover.selectGroup': 'Select all in {{group}}',
    'caxriBot.handover.selectCandidate': 'Select {{title}}',
    'caxriBot.handover.addsProject': 'Adds this folder as a Project',
    'caxriBot.handover.mayBeOpen': 'May be open elsewhere',
    'caxriBot.handover.mayBeOpenWarning':
        'A conversation you picked was active in the last few minutes. If it is still open in another terminal, both copies will continue separately.',
    'caxriBot.handover.tooMany':
        'Hand over at most {{max}} at once. Deselect {{excess}} to continue.',
    'caxriBot.handover.untitledConversation': 'Untitled conversation',
    'caxriBot.handover.refusedReason': 'Not handed over: {{reason}}',
    'caxriBot.handover.noteLabel': 'Note for Caxri Bot',
    'caxriBot.handover.notePlaceholder':
        'Optional: what Caxri Bot should do, for example "finish the migration and open a pull request"',
    'caxriBot.handover.takeBackHint':
        'Typing into a handed-over Session, or sending a message or stopping in its Chat, takes it back.',
    'caxriBot.handover.selectedCount': '{{count}} selected',
    'caxriBot.handover.submit': 'Hand Over',
    'caxriBot.handover.submitting': 'Handing over…',
    'caxriBot.handover.failed': 'Unable to hand over to Caxri Bot',
    'caxriBot.handover.noneAccepted': 'Nothing was handed over: {{reason}}',
    'caxriBot.handover.partlyAccepted':
        'Handed {{accepted}} to Caxri Bot; {{refused}} could not be handed over',
    'caxriBot.handover.acceptedOne': 'Handed 1 Session to Caxri Bot',
    'caxriBot.handover.acceptedOther': 'Handed {{count}} Sessions to Caxri Bot',
    'caxriBot.handover.takeBackFailed': 'Unable to take the Session back',
    'caxriBot.handover.takenBack': 'Took the Session back from Caxri Bot',
    'caxriBot.handover.takenBackByInput': 'Took {{title}} back from Caxri Bot',
    'caxriBot.handover.takenBackByInputUntitled': 'Took a Session back from Caxri Bot',
    'caxriBot.handover.handBack': 'Hand Back',
    'caxriBot.handover.rejection.alreadyManaged': 'Caxri Bot already manages it',
    'caxriBot.handover.rejection.botSession': 'it is Caxri Bot itself',
    'caxriBot.handover.rejection.botUnavailable': 'Caxri Bot is not set up',
    'caxriBot.handover.rejection.conversationBound':
        'a Caxri Terminal already has this conversation',
    'caxriBot.handover.rejection.conversationMissing':
        'the conversation or its folder no longer exists',
    'caxriBot.handover.rejection.duplicate': 'it was picked twice',
    'caxriBot.handover.rejection.ownershipCapacity': 'Caxri Bot manages too many Sessions',
    'caxriBot.handover.rejection.projectUnavailable': 'its Project is hidden or unavailable',
    'caxriBot.handover.rejection.sessionArchived': 'the Session is archived',
    'caxriBot.handover.rejection.sessionMissing': 'the Session no longer exists',
    'caxriBot.handover.rejection.taskCapacity': 'Caxri Bot has too many open tasks',
    'caxriBot.board.handoverContinuable':
        'Handed over by you. Caxri Bot continues this conversation once its Agent is between turns.',
    'caxriBot.board.handoverOwnershipOnly':
        'Handed over by you. There is no Agent conversation to continue, so Caxri Bot starts new work here.',

    // Workbench Session row marker
    'caxriBot.sessionMarker.managed': 'Managed by Caxri Bot',
    'caxriBot.sessionMarker.inputTakesBack': 'Managed by Caxri Bot · typing here takes it back',
    'caxriBot.sessionMarker.chatInputTakesBack':
        'Managed by Caxri Bot · sending a message or stopping here takes it back',
} as const;
