/**
 * Settings page chrome and the registry's own rows (rows that are not a protocol catalog entry, such as the Agent
 * provider rows and the argv-backed switches).
 */
export const settingsPage = {
    'settings.page.heading': 'Settings',
    'settings.page.intro': 'Changes apply immediately and are stored as editable files.',
    'settings.page.sections': 'Settings sections',
    'settings.page.tab.settings': 'Settings',
    'settings.page.tab.keybindings': 'Keybindings',
    'settings.page.tab.theme': 'Theme',
    'settings.page.viewToggle': 'Settings view',
    'settings.page.view.ui': 'UI',
    'settings.page.view.source': 'Source',
    'settings.page.categoriesNav': 'Settings categories',
    'settings.page.search': 'Search settings',
    'settings.page.clearSearch': 'Clear Search',
    'settings.page.clearSearchLabel': 'Clear settings search',
    'settings.page.searchCount': '{{visible}} of {{total}} settings',
    'settings.page.noMatches': 'No settings match “{{query}}”',
    'settings.page.accessibleTitle': '{{category}} {{title}}',
    'settings.page.resetToDefault': 'Reset to default',
    'settings.page.resetRowToDefault': 'Reset {{title}} to default',
    'settings.page.moreAbout': 'More about {{title}}',
    'settings.page.loadFailed': 'Unable to load configuration',
    'settings.page.skillHealthFailed': 'Unable to inspect Caxri CLI skills',

    'settings.source.editorLabel': '{{fileName}} source',
    'settings.source.goToLine': 'Go to line {{line}}',
    'settings.source.revert': 'Revert changes',
    'settings.source.parseLocation': '{{description}} on line {{line}}, column {{column}}',
    'settings.source.invalidConfiguration': 'Invalid configuration',
    'settings.source.parseError.invalidSymbol': 'An invalid symbol was found',
    'settings.source.parseError.invalidNumberFormat': 'This number is not valid',
    'settings.source.parseError.propertyNameExpected': 'A property name is missing',
    'settings.source.parseError.valueExpected': 'A value is missing',
    'settings.source.parseError.colonExpected': 'A colon : is missing',
    'settings.source.parseError.commaExpected': 'A comma , is missing',
    'settings.source.parseError.closeBraceExpected': 'A closing brace } is missing',
    'settings.source.parseError.closeBracketExpected': 'A closing bracket ] is missing',
    'settings.source.parseError.endOfFileExpected': 'Extra content appears after the JSON value',
    'settings.source.parseError.invalidCommentToken': 'This comment is not valid',
    'settings.source.parseError.unexpectedEndOfComment': 'This comment is not closed',
    'settings.source.parseError.unexpectedEndOfString': 'This string is not closed',
    'settings.source.parseError.unexpectedEndOfNumber': 'This number is incomplete',
    'settings.source.parseError.invalidUnicode': 'This Unicode escape is not valid',
    'settings.source.parseError.invalidEscapeCharacter': 'This escape character is not valid',
    'settings.source.parseError.invalidCharacter': 'An invalid character was found',
    'settings.source.parseError.unknown': 'Invalid JSON syntax',

    'settings.integerControl.range': 'Enter a number between {{lower}} and {{upper}}.',
    'settings.integerControl.rangeWithUnit':
        'Enter a number between {{lower}} and {{upper}} {{unit}}.',
    'settings.integerControl.wholeNumber': 'Enter a whole number between {{lower}} and {{upper}}.',
    'settings.integerControl.wholeNumberWithUnit':
        'Enter a whole number between {{lower}} and {{upper}} {{unit}}.',

    'settings.argvRestart.prefix': 'Restart Caxri to apply the new ',
    'settings.argvRestart.namedOne': '{{titles}} setting.',
    'settings.argvRestart.namedOther': '{{titles}} settings.',
    'settings.argvRestart.unnamedOne': 'setting.',
    'settings.argvRestart.unnamedOther': 'settings.',
    'settings.argvRestart.listSeparator': ', ',
    'settings.argvRestart.listFinalSeparator': ' and ',

    'settings.row.skippedVersion.current': 'Currently skipping {{version}}.',
    'settings.row.skippedVersion.none': 'No version currently skipped.',
    'settings.row.archivedSessions.title': 'Archived Sessions',
    'settings.row.archivedSessions.description': 'Restore or permanently delete archived Sessions',
    'settings.row.archivedSessions.manage': 'Manage…',
    'settings.row.mobileAccess.title': 'Mobile access',
    'settings.row.mobileAccess.description':
        'Pair phones and tablets on this local network to review scoped Agent Sessions and send short replies',
    'settings.row.hardwareAcceleration.title': 'Hardware acceleration',
    'settings.row.hardwareAcceleration.description':
        "Controls whether the whole app draws with your graphics hardware, including every Terminal's GPU acceleration below. Off, Caxri uses software rendering, which is slower but keeps working when graphics fail. Caxri only changes this after you confirm it, and a change takes effect after a restart.",
    'settings.row.hardwareAcceleration.offStatus':
        'Caxri starts with software rendering until this is turned back on.',
    'settings.row.remoteDebugging.title': 'Debugging port',
    'settings.row.remoteDebugging.description':
        'On, Caxri listens on 127.0.0.1:9224 and any program running on this Mac can attach to it over the Chrome DevTools Protocol. Whatever attaches can read every window, run code in it, and act as you. Nothing on another machine can reach that address. Off, nothing is listening. Applies to the installed app the next time it starts; a Caxri started from source always listens, on 127.0.0.1:9223.',
    'settings.row.delegationDepth.title': 'Delegation depth',
    'settings.row.delegationDepth.description':
        'How many times in a row an Agent may hand part of its job to another Agent.',
    'settings.row.delegationDepth.detail':
        '1 lets the Agent you started bring in one helper, which then finishes alone; 2 lets that helper bring in one more. Which Agents may be brought in is set by the delegation presets, in the Source view.',

    'settings.row.providerActions.title': 'Agent commands & skills',
    'settings.row.providerActions.description':
        'Customize slash commands and skill invocations shown in the Agent Commands & Skills picker. Project and user skills are discovered automatically.',
    'settings.row.providerActions.unavailable':
        'Actions and skills are unavailable for {{provider}}.',
    'settings.row.providerHooks.title': 'Lifecycle hooks',
    'settings.row.providerHooks.description':
        'Keeps background Session unread state accurate. Caxri only receives lifecycle phases, never prompt or response content. Restart Agent Terminals opened before lifecycle hooks were enabled.',
    'settings.row.providerHooks.label': '{{provider}} lifecycle hooks',
    'settings.row.providerMessaging.title': 'Peer messaging',
    'settings.row.providerMessaging.description':
        'Lets this Agent send and receive short messages with other Agents through the Peer Inbox. Messages are never typed into the Terminal. Turning this off takes effect immediately; restart the Terminal only if messaging stays unavailable.',
    'settings.row.providerMessaging.label': '{{provider}} peer messaging',
    'settings.row.providerMessaging.unavailable': 'Unavailable for {{provider}}.',
    'settings.row.providerRecovery.title': 'Network error recovery',
    'settings.row.providerRecovery.description':
        'When the Agent stops on a network error Caxri recognizes, or on one of your extra patterns, Caxri waits, presses Esc, waits again, and sends “continue”. Off by default.',
    'settings.row.providerRecovery.label': '{{provider}} network error recovery',
    'settings.row.providerSkill.title': 'Caxri CLI skill',
    'settings.row.providerSkill.description':
        'Installation health of the bundled Caxri skill for this provider',
    'settings.row.providerExecutable.title': 'Executable',
    'settings.row.providerExecutable.description':
        'Command used to launch this Agent in new Terminals',
    'settings.row.providerExecutable.label': '{{provider}} executable',
    'settings.row.providerAutonomy.title': 'Let the Agent act without asking each time',
    'settings.row.providerAutonomy.description':
        'On, this Agent edits files and runs commands in its Terminal without stopping for your approval each time. Off, it asks before each action. Applies to Terminals started from now on, not ones already running.',
    'settings.row.providerAutonomy.label': 'Let {{provider}} act without asking each time',
    'settings.row.providerArgs.title': 'Initial arguments',
    'settings.row.providerArgs.description':
        'Passed on every launch. Write flags the way you would on the command line; a flag and its value can share a line.',
    'settings.row.providerArgs.label': '{{provider}} initial arguments',
} as const;
