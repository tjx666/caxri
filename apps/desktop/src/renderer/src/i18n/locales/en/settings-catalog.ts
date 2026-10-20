/**
 * Display text for the protocol settings catalog (`@caxri/protocol` `settingsSpec`), keyed by setting key. The catalog
 * keeps its English text as the source Settings search indexes; these entries mirror it word for word (enforced by
 * `settings-catalog-parity.test.ts`) so the Renderer can show the active locale. `settings.<key>.title` must exist for
 * every setting key and `settings.<key>.description` for every described one: the Settings registry looks them up
 * through template literals that fail type checking when an entry is missing.
 */
export const settingsCatalog = {
    'settings.category.general': 'General',
    'settings.category.notifications': 'Notifications',
    'settings.category.mobile': 'Mobile',
    'settings.category.terminal': 'Terminal',
    'settings.category.editor': 'Editor',
    'settings.category.security': 'Security',
    'settings.category.files': 'Files',
    'settings.category.projectStatus': 'Project Status',
    'settings.category.agents': 'Agents',

    'settings.unit.px': 'px',
    'settings.unit.lines': 'lines',
    'settings.unit.characters': 'characters',
    'settings.unit.minutes': 'minutes',
    'settings.unit.MB': 'MB',
    'settings.unit.seconds': 'seconds',

    'settings.workbench.language.title': 'Language',
    'settings.workbench.language.description':
        'Display language of the interface. Follow system uses Simplified Chinese when the system language is Chinese.',
    'settings.workbench.language.nullLabel': 'Follow system',
    'settings.workbench.language.nullLabelResolved': 'Follow system ({{language}})',

    'settings.notifications.worktreeFallback.title': 'Worktree fallback reminders',
    'settings.notifications.worktreeFallback.description':
        'Show a popup when an unavailable worktree returns to its Project. Turn on to restore muted reminders. Applies to all Projects; recent events remain in Notifications.',
    'settings.notifications.agentRecovery.title': 'Automatic Agent recovery reminders',
    'settings.notifications.agentRecovery.description':
        'Show a popup after automatic Agent recovery. Turn on to restore muted reminders. Applies to all Projects; failures always appear.',

    'settings.session.defaultAgent.title': 'Default Agent',
    'settings.session.defaultAgent.description':
        'Starts new Sessions and new Terminals with this Agent. Ask each time opens the list instead, and the New Terminal button always offers the other Agents.',
    'settings.session.defaultAgent.nullLabel': 'Ask each time',

    'settings.session.openAgentsInChat.title': 'Open Agents in Chat',
    'settings.session.openAgentsInChat.description':
        'Starts new Agents as a Chat instead of a Terminal. Shell always opens in a Terminal. The New Session and New Terminal menus toggle this too.',

    'settings.agentChat.longPasteThreshold.title': 'Chat long paste threshold',
    'settings.agentChat.longPasteThreshold.description':
        'Longer text pasted into a Chat is saved to a local file and the message cites it, so a log or a dump does not bury the message. Raise it to paste such text as is; text that would not fit in one message is still saved to a file.',

    'settings.workbench.newWorktreeBehavior.title': 'New worktree behavior',
    'settings.workbench.newWorktreeBehavior.description':
        'Choose whether to follow detected worktrees. Continue automatically authorizes new worktree folders without asking.',
    'settings.workbench.newWorktreeBehavior.option.ask': 'Ask',
    'settings.workbench.newWorktreeBehavior.option.continueWhenAuthorized':
        'Continue when authorized',
    'settings.workbench.newWorktreeBehavior.option.continueAutomatically': 'Continue automatically',
    'settings.workbench.newWorktreeBehavior.option.ignore': 'Ignore',

    'settings.workbench.confirmWorktreeAuthorization.title': 'Confirm worktree authorization',
    'settings.workbench.confirmWorktreeAuthorization.description':
        'Ask before authorizing a worktree picked from the status bar. Turn off to authorize and switch right away.',

    'settings.primarySidebar.autoCollapseProjects.title': 'Auto-collapse inactive Projects',
    'settings.primarySidebar.autoCollapseProjects.description':
        'Keeps active, working, unread, and manually expanded Projects open',
    'settings.primarySidebar.autoCollapseProjects.option.off': 'Off',
    'settings.primarySidebar.autoCollapseProjects.option.30m': 'After 30 minutes',
    'settings.primarySidebar.autoCollapseProjects.option.2h': 'After 2 hours',

    'settings.primarySidebar.translucent.title': 'Translucent sidebar',
    'settings.primarySidebar.translucent.description':
        'On macOS, blur the desktop through the sidebar like frosted glass when the theme matches the system light or dark appearance.',

    'settings.statusBar.usage.showFiveHourLimit.title': 'Show 5-hour limit in the status bar',
    'settings.statusBar.usage.showFiveHourLimit.description':
        'Adds the 5-hour plan limit to the Agent usage chip beside the weekly limit. Its hover card always lists every limit.',

    'settings.window.zoomLevel.title': 'Zoom level',
    'settings.window.zoomLevel.description':
        'Scales the whole interface. 0 is the original size; each step up or down zooms by 20%. View › Zoom In, Zoom Out, and Reset Zoom change it too.',

    'settings.workbench.fontFamily.title': 'Font family',
    'settings.workbench.fontFamily.description':
        'Workbench UI font; leave empty for the system font',
    'settings.workbench.fontFamily.placeholder': 'System font',

    'settings.workbench.externalEditor.title': 'External editor',
    'settings.workbench.externalEditor.description':
        'Command used by “Open Project in External Editor” (e.g. code, cursor, subl)',

    'settings.updates.skippedVersion.title': 'Skipped update version',
    'settings.updates.skippedVersion.description':
        'Caxri stops offering this release until a newer one appears. Reset to be offered it again.',

    'settings.terminal.fontFamily.title': 'Font family',
    'settings.terminal.fontFamily.description':
        'Used before the bundled JetBrains Mono fallback stack',

    'settings.terminal.fontSize.title': 'Font size',

    'settings.terminal.scrollback.title': 'Scrollback lines',
    'settings.terminal.scrollback.description':
        'Lines kept in the Terminal buffer beyond the visible viewport',

    'settings.terminal.longPasteThreshold.title': 'Long paste threshold',
    'settings.terminal.longPasteThreshold.description':
        'Longer text pasted into a running Agent is saved to a local file and replaced with its path, so the Agent reads it instead of receiving it through the Terminal. The maximum keeps ordinary pastes native; larger text is still saved to a file.',

    'settings.terminal.copyOnSelect.title': 'Copy on select',
    'settings.terminal.copyOnSelect.description':
        'Automatically copy Terminal selections to the clipboard',

    'settings.terminal.gpuAcceleration.title': 'Terminal hardware acceleration',
    'settings.terminal.gpuAcceleration.description':
        'Draws the Terminal with the graphics card; turn off to use software rendering. Takes effect without restarting the Terminal. Has no effect while Hardware acceleration is off, since that already draws every Terminal in software.',
    'settings.terminal.gpuAcceleration.option.auto': 'Auto',
    'settings.terminal.gpuAcceleration.option.on': 'On',
    'settings.terminal.gpuAcceleration.option.off': 'Off',

    'settings.terminal.suspendUntouchedAgents.title': 'Suspend Agents you opened but never used',
    'settings.terminal.suspendUntouchedAgents.description':
        'Suspends an Agent you never typed into once you switch to another Session, to save memory. It picks up where it left off when you come back.',

    'settings.terminal.idleSuspension.enabled.title': 'Suspend idle Agents in the background',
    'settings.terminal.idleSuspension.enabled.description':
        'Suspends an Agent that finished its work and waited in a Session you are not viewing, to save memory. It picks up where it left off when you come back.',

    'settings.terminal.idleSuspension.afterMinutes.title': 'Suspend idle Agents after',
    'settings.terminal.idleSuspension.afterMinutes.description':
        'How long an Agent waits, in a Session you are not viewing, before it is suspended. Used only while Suspend idle Agents in the background is on.',

    'settings.terminal.osc52ClipboardWrite.title':
        'Let programs in the Terminal copy to your clipboard',
    'settings.terminal.osc52ClipboardWrite.description':
        'Programs such as tmux or a remote shell may copy text to your clipboard through OSC 52; they can never read it',

    'settings.terminal.wordSeparators.title': 'Word separators',
    'settings.terminal.wordSeparators.description':
        'Characters that end a word when you double-click to select, and when Caxri looks for file names to link. Links such as file.ts:12 are found either way',

    'settings.terminal.referenceLinks.title': 'Reference links',
    'settings.terminal.referenceLinks.description':
        'Turn issue markers such as TASK-123 into links, using a web address template',

    'settings.terminal.defaultWorkingDirectory.title': 'New Terminal working directory',
    'settings.terminal.defaultWorkingDirectory.description':
        'Leave empty to use the current Workbench Root',
    'settings.terminal.defaultWorkingDirectory.placeholder': 'Current Workbench Root',

    'settings.editor.fontFamily.title': 'Font family',
    'settings.editor.fontFamily.description':
        'Code and diff editor font; leave empty for the Monaco default',
    'settings.editor.fontFamily.placeholder': 'Monaco default',

    'settings.editor.fontSize.title': 'Font size',
    'settings.editor.fontSize.description': 'Code and diff editor font size',

    'settings.editor.wordWrap.title': 'Word wrap',
    'settings.editor.wordWrap.description': 'Wrap long lines instead of scrolling horizontally',
    'settings.editor.wordWrap.option.off': 'Off',
    'settings.editor.wordWrap.option.on': 'At the viewport edge',
    'settings.editor.wordWrap.option.bounded': 'At 80 columns or the viewport edge',

    'settings.editor.wordSeparators.title': 'Word separators',
    'settings.editor.wordSeparators.description':
        'Characters that end a word for double-click selection and word-wise cursor movement',

    'settings.editor.autoClosingDelete.title': 'Delete both halves of a pair',
    'settings.editor.autoClosingDelete.description':
        'Deleting one half of an empty bracket or quote pair removes the other. Only ever applies to an adjacent empty pair.',
    'settings.editor.autoClosingDelete.option.always': 'Always',
    'settings.editor.autoClosingDelete.option.auto': 'Only pairs this editor inserted',
    'settings.editor.autoClosingDelete.option.never': 'Never',

    'settings.editor.linkedEditing.title': 'Linked editing',
    'settings.editor.linkedEditing.description':
        'Renaming an HTML or JSX tag renames its matching tag as you type',

    'settings.editor.stickyScroll.enabled.title': 'Sticky scroll',
    'settings.editor.stickyScroll.enabled.description':
        'Pin the enclosing scopes of the top line to the top of the editor',

    'settings.editor.stickyTabStops.title': 'Sticky tab stops',
    'settings.editor.stickyTabStops.description':
        'Move the cursor across space indentation one indent level at a time',

    'settings.editor.bracketPairColorization.enabled.title': 'Bracket pair colorization',
    'settings.editor.bracketPairColorization.enabled.description':
        'Color matching brackets by nesting depth',

    'settings.editor.guides.bracketPairs.title': 'Bracket pair guides',
    'settings.editor.guides.bracketPairs.description': 'Vertical guides connecting a bracket pair',
    'settings.editor.guides.bracketPairs.option.off': 'Off',
    'settings.editor.guides.bracketPairs.option.active': 'Only the active pair',
    'settings.editor.guides.bracketPairs.option.all': 'All pairs',

    'settings.editor.renderWhitespace.title': 'Render whitespace',
    'settings.editor.renderWhitespace.description': 'Show space and tab characters',
    'settings.editor.renderWhitespace.option.none': 'Never',
    'settings.editor.renderWhitespace.option.boundary': 'Except single spaces between words',
    'settings.editor.renderWhitespace.option.selection': 'Inside the selection',
    'settings.editor.renderWhitespace.option.trailing': 'Trailing only',
    'settings.editor.renderWhitespace.option.all': 'Always',

    'settings.editor.cursorBlinking.title': 'Cursor blinking',
    'settings.editor.cursorBlinking.description':
        'How the caret animates between visible and hidden',
    'settings.editor.cursorBlinking.option.blink': 'Blink',
    'settings.editor.cursorBlinking.option.smooth': 'Smooth',
    'settings.editor.cursorBlinking.option.phase': 'Phase',
    'settings.editor.cursorBlinking.option.expand': 'Expand',
    'settings.editor.cursorBlinking.option.solid': 'Solid',

    'settings.editor.cursorSmoothCaretAnimation.title': 'Smooth caret animation',
    'settings.editor.cursorSmoothCaretAnimation.description':
        'Animate the caret as it moves between positions',
    'settings.editor.cursorSmoothCaretAnimation.option.off': 'Off',
    'settings.editor.cursorSmoothCaretAnimation.option.explicit': 'Only for explicit moves',
    'settings.editor.cursorSmoothCaretAnimation.option.on': 'Always',

    'settings.editor.smoothScrolling.title': 'Smooth scrolling',
    'settings.editor.smoothScrolling.description': 'Animate the editor viewport as it scrolls',

    'settings.editor.dragAndDrop.title': 'Drag and drop selected text',
    'settings.editor.dragAndDrop.description': 'Move a selection by dragging it inside the editor',

    'settings.editor.minimap.enabled.title': 'Minimap',
    'settings.editor.minimap.enabled.description':
        'Show the code overview strip along the right edge',

    'settings.editor.unfoldOnClickAfterEndOfLine.title': 'Unfold on click after end of line',
    'settings.editor.unfoldOnClickAfterEndOfLine.description':
        'Clicking the empty space after a folded line unfolds it',

    'settings.editor.foldOnOpenLineThreshold.title': 'Fold on open above',
    'settings.editor.foldOnOpenLineThreshold.description':
        'Collapse every block of a file longer than this the first time it opens; JSON keeps its top-level keys visible. Unfold All (⌘K ⌘J) expands it again. Set to 0 to never fold on open.',

    'settings.git.fetchGitHubAvatars.title': 'Fetch commit avatars from GitHub',
    'settings.git.fetchGitHubAvatars.description':
        'Look up commit author avatars on GitHub; author emails are sent to github.com. Only used in repositories with a GitHub remote.',

    'settings.security.trustedDomains.title': 'Trusted domains',
    'settings.security.trustedDomains.description':
        'Links on these domains open without a confirmation prompt',

    'settings.security.trustedFolders.title': 'Trusted folders',
    'settings.security.trustedFolders.description':
        'Terminal file links under these folders open in the editor without a confirmation prompt; saving writes back to the file',

    'settings.files.exclude.title': 'Excluded files',
    'settings.files.exclude.description': 'Glob patterns hidden from the file tree',

    'settings.git.diffExclude.title': 'Excluded Git diff files',
    'settings.git.diffExclude.description':
        'Hide matching repository-relative paths from Git change lists and Open All Changes. Tests and translation catalogs are excluded by default. Use the Source Control eye button to show them temporarily. Supports *, **, and ?; this does not change Git tracking.',

    'settings.files.maxFileBytes.title': 'Maximum editable file size',
    'settings.files.maxFileBytes.description':
        "Larger files can't be opened in the editor and are skipped by search. Use Open with Default App for them.",

    'settings.projectStatus.ignoredChecks.title': 'Ignored checks',
    'settings.projectStatus.ignoredChecks.description':
        'Checks left out of the CI rollup, the sidebar badge, and failure notifications',

    'settings.projectStatus.notifyAgentOnMerge.title':
        'Tell the Agent after you merge from Project Status',
    'settings.projectStatus.notifyAgentOnMerge.description':
        'Sends “Pull request <link> has been merged.” to the Session’s Agent as a new message. Merges made on GitHub are not reported.',

    'settings.projectStatus.notifications.enabled.title': 'Delivery failure notifications',
    'settings.projectStatus.notifications.enabled.description':
        'Notify when a CI check or a Vercel deployment starts failing',

    'settings.agents.providers.title': 'Agent providers',
    'settings.agents.providers.description':
        'Launch commands, lifecycle hooks, peer messaging, and output recovery per Agent provider',

    'settings.agents.delegation.title': 'Agent delegation',
    'settings.agents.delegation.description':
        'Named delegation presets, caller bindings and maximum delegation depth',

    'settings.agents.notifications.enabled.title': 'System notifications',
    'settings.agents.notifications.enabled.description':
        'Notify when a background Agent needs attention; provider lifecycle hooks must also be enabled',

    'settings.agents.notifications.completionThresholdSeconds.title': 'Completed turn threshold',
    'settings.agents.notifications.completionThresholdSeconds.description':
        'Only notify for completed Agent turns that ran for at least this long',
} as const;
