export const settingsAgents = {
    // Lifecycle-hook health caption
    'settings.providerHealth.hook.disabled': 'Disabled',
    'settings.providerHealth.hook.checking': 'Checking installation…',
    'settings.providerHealth.hook.unsupported': 'Not available on this platform',
    'settings.providerHealth.hook.notInstalled': 'Not in effect',
    'settings.providerHealth.hook.installedPending': 'Not in effect until your next Agent session',
    'settings.providerHealth.hook.incompatible': 'Newer installation is incomplete',
    'settings.providerHealth.hook.active': 'Active',
    'settings.providerHealth.hook.stale': 'Out of date — restart Agent Terminals to update it',
    'settings.providerHealth.hook.drifted':
        'Changed outside Caxri — restart Agent Terminals to reapply it',
    'settings.providerHealth.hook.conflict': 'Blocked by your configuration',
    'settings.providerHealth.hook.error': 'Setup failed — restart Agent Terminals to try again',
    'settings.providerHealth.hook.withMessage': '{{label}} — {{message}}',
    'settings.providerHealth.hook.caption': 'Installation: {{label}}',
    // Bundled skill health
    'settings.providerHealth.skill.scope.local': 'Project local',
    'settings.providerHealth.skill.scope.global': 'Global',
    'settings.providerHealth.skill.checking': '{{scope}} · Checking installation…',
    'settings.providerHealth.skill.action.foreign-entry':
        'Keep this entry; Caxri never overwrites or removes a skill it did not install.',
    'settings.providerHealth.skill.action.invalid-installed-version':
        'Use a matching Caxri CLI, or inspect this installation by hand.',
    'settings.providerHealth.skill.action.invalid-marker':
        'Keep this entry and inspect its Caxri marker by hand.',
    'settings.providerHealth.skill.action.matches-bundle': 'Nothing to do.',
    'settings.providerHealth.skill.action.modified-or-foreign-files':
        'This copy was changed. Back it up and remove it by hand before reinstalling.',
    'settings.providerHealth.skill.action.newer-version':
        'Use Caxri CLI {{version}} or newer; this one will not downgrade it.',
    'settings.providerHealth.skill.action.not-installed': 'Install the bundled skill here.',
    'settings.providerHealth.skill.action.older-version': 'Update it to the bundled version.',
    'settings.providerHealth.skill.action.same-version-contract-mismatch':
        'Same version, different contents. Inspect it by hand before reinstalling.',
    'settings.providerHealth.skill.action.unknown-schema':
        'Use a Caxri CLI that supports marker schema {{schema}}; this one will not overwrite it.',
    'settings.providerHealth.skill.action.unreadable-installation':
        'Keep this entry and inspect its files by hand.',
    'settings.providerHealth.skill.action.unsafe-parent':
        'The Provider folder is a link. Choose a safe Project root or the global scope.',
    'settings.providerHealth.skill.selectProject': '{{scope}} · Select a Project to inspect',
    'settings.providerHealth.skill.uninspectable': '{{scope}} · Unable to inspect this location',
    'settings.providerHealth.skill.notInstalled': '{{scope}} · Not installed',
    'settings.providerHealth.skill.installed': '{{scope}} · {{status}} · installed v{{version}}',
    'settings.providerHealth.skill.status.compatible': 'Compatible',
    'settings.providerHealth.skill.status.conflict': 'Conflict',
    'settings.providerHealth.skill.status.missing': 'Missing',
    'settings.providerHealth.skill.status.stale': 'Stale',
    'settings.providerHealth.skill.unavailable': 'Bundled skills are unavailable for {{provider}}.',
    'settings.providerHealth.skill.bundle': 'Bundle',
    'settings.providerHealth.skill.bundledVersion': 'Bundled v{{version}}',
    'settings.providerHealth.skill.checkingBundle': 'Checking bundle…',
    'settings.providerHealth.skill.copyCommand': 'Copy command',
    // Network error recovery editor
    'settings.providerRecovery.patternTooLong': 'Each pattern must be {{max}} characters or fewer.',
    'settings.providerRecovery.tooManyPatterns': 'Add at most {{max}} patterns.',
    'settings.providerRecovery.delayRange': 'Enter an integer from {{min}} to {{max}} ms.',
    'settings.providerRecovery.patternsLabel': 'Additional ending output patterns',
    'settings.providerRecovery.patternsAriaLabel': '{{provider}} additional ending output patterns',
    'settings.providerRecovery.patternsDescription':
        "One phrase per line, matched at the end of the Agent's output, ignoring case. Caxri already recognizes common network errors for this Agent. Checked once the Terminal stops printing.",
    'settings.providerRecovery.noPatterns': 'No additional patterns configured.',
    'settings.providerRecovery.waitBeforeEsc': 'Wait before Esc',
    'settings.providerRecovery.waitBeforeContinue': 'Wait before Continue',
    'settings.providerRecovery.delayAriaLabel': '{{provider}} {{label}}',
    // Agent commands & skills editor
    'settings.agentActionsEditor.listLabel': '{{provider}} Agent commands and skills',
    'settings.agentActionsEditor.builtIn': 'Built-in',
    'settings.agentActionsEditor.builtInDescription.claude./model': 'Choose the active model',
    'settings.agentActionsEditor.builtInDescription.claude./compact':
        'Summarize the conversation to free context',
    'settings.agentActionsEditor.builtInDescription.claude./diff':
        'Review uncommitted and per-turn changes',
    'settings.agentActionsEditor.builtInDescription.claude./review': 'Review the current diff',
    'settings.agentActionsEditor.builtInDescription.claude./context':
        'Visualize current context usage',
    'settings.agentActionsEditor.builtInDescription.codex./model':
        'Choose the active model and reasoning effort',
    'settings.agentActionsEditor.builtInDescription.codex./compact':
        'Summarize the conversation to free context',
    'settings.agentActionsEditor.builtInDescription.codex./diff': 'Show the current Git diff',
    'settings.agentActionsEditor.builtInDescription.codex./review':
        'Review the current working tree',
    'settings.agentActionsEditor.builtInDescription.codex./status':
        'Show session configuration and token usage',
    'settings.agentActionsEditor.show': 'Show {{invocation}}',
    'settings.agentActionsEditor.descriptionFor': 'Description for {{invocation}}',
    'settings.agentActionsEditor.optionalDescription': 'Optional description',
    'settings.agentActionsEditor.remove': 'Remove command or skill',
    'settings.agentActionsEditor.removeNamed': 'Remove command or skill {{invocation}}',
    'settings.agentActionsEditor.newInvocation': 'New command or skill invocation',
    'settings.agentActionsEditor.newDescription': 'New command or skill description',
    'settings.agentActionsEditor.add': 'Add command or skill',
    'settings.agentActionsEditor.unavailable': 'Unavailable',
    'settings.agentActionsEditor.invalidInvocation':
        'Use an exact invocation starting with / or $, without spaces.',
    'settings.agentActionsEditor.atCapacity':
        'Remove an override before adding another command or skill.',
    // Default model (Agent Chat global default)
    'settings.chatDefaults.loading': 'Reading {{provider}} settings…',
    'settings.chatDefaults.loadFailed': 'Could not read {{provider}} settings.',
    'settings.chatDefaults.saveFailed': 'Unable to save the default model',
    'settings.chatDefaults.model': 'Model',
    'settings.chatDefaults.effort': 'Reasoning effort',
    'settings.chatDefaults.agentModel': '{{provider}} default',
    'settings.chatDefaults.modelEffort': "The model's default",
    'settings.chatDefaults.ultracode': 'Ultracode',
    'settings.chatDefaults.ultracodeDescription':
        'Multi-agent workflows at any effort, on models that offer it',
    'settings.chatDefaults.ultracodeValue.on': 'Ultracode on',
    'settings.chatDefaults.ultracodeValue.off': 'Ultracode off',
    'settings.chatDefaults.noModels': 'Open a {{provider}} Chat once to choose from its models.',
    'settings.chatDefaults.override.launchArgs':
        'Initial arguments set {{value}}, so new Chats use that instead.',
    'settings.chatDefaults.override.environment':
        'An environment variable sets {{value}}, so new Chats use that instead.',
    'settings.chatDefaults.file': 'Saved in {{file}}, which the {{provider}} CLI reads too.',
} as const;
