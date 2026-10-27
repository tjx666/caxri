export const settingsClaudeWindows = {
    'settings.claudeWindows.loading': 'Checking the Claude account…',
    'settings.claudeWindows.loadFailed': 'Could not check the Claude account.',
    'settings.claudeWindows.saveFailed':
        'Could not save. The Claude account may have changed; try again.',
    'settings.claudeWindows.plan.pro': 'Claude Pro',
    'settings.claudeWindows.plan.max': 'Claude Max',
    'settings.claudeWindows.planLine': 'Plan: {{plan}}',
    'settings.claudeWindows.keepRolling': 'Keep 5-hour windows rolling',
    'settings.claudeWindows.keepRollingDescription':
        'Starts each 5-hour window with one minimal request when the previous one resets, so your first window of the day resets when your workday starts. On by default for Pro; off by default for Max. To keep working while Caxri is closed, it registers a background job with macOS (listed under Login Items); turning this off removes it.',
    'settings.claudeWindows.defaultNotice':
        'Caxri keeps your Claude 5-hour windows rolling: when a window resets, it sends Claude one minimal request to start the next one, also while Caxri is closed. This is on by default for Claude Pro.',
    'settings.claudeWindows.firstWorkdayReset': 'First workday reset at',
    'settings.claudeWindows.warmUpNote':
        'Caxri starts a warm-up window at {{warmUp}}, five hours earlier, so it resets at {{reset}}.',
    'settings.claudeWindows.nextWarmUp': 'Next warm-up',
    'settings.claudeWindows.nextWorkdayReset': 'Next workday reset',
    'settings.claudeWindows.lastOutcomeLabel': 'Last check',
    'settings.claudeWindows.lastOutcome': '{{outcome}} · {{time}}{{missed}}',
    'settings.claudeWindows.time.today': 'Today {{time}}',
    'settings.claudeWindows.time.tomorrow': 'Tomorrow {{time}}',
    'settings.claudeWindows.time.yesterday': 'Yesterday {{time}}',
    'settings.claudeWindows.time.date': '{{month}}/{{day}} {{time}}',
    // Status
    'settings.claudeWindows.status.off': 'Off',
    'settings.claudeWindows.status.waitingForAnchor': 'Waiting for the next warm-up',
    'settings.claudeWindows.status.windowActive': 'Window active, resets {{time}}',
    'settings.claudeWindows.status.waitingForNaturalReset':
        'Window active, resets {{time}}; the next warm-up starts the day fresh',
    'settings.claudeWindows.status.triggering': 'Starting a window…',
    'settings.claudeWindows.status.confirmed': 'Window started, resets {{time}}',
    'settings.claudeWindows.status.unavailable': 'Paused',
    'settings.claudeWindows.status.unavailableBecause': 'Paused: {{reason}}',
    // Unavailable reasons
    'settings.claudeWindows.reason.notSignedIn': 'Claude Code is not signed in to a Claude account',
    'settings.claudeWindows.reason.authUnsupported':
        'Claude Code uses an API key or another provider, which would bill API usage',
    'settings.claudeWindows.reason.planUnsupported': 'this plan is not Claude Pro or Max',
    'settings.claudeWindows.reason.usageUnavailable':
        'Claude Code did not report the 5-hour window',
    'settings.claudeWindows.reason.weeklyLimit': 'the weekly limit is used up',
    'settings.claudeWindows.reason.claudeNotFound': 'Claude Code is not installed',
    'settings.claudeWindows.reason.probeFailed': 'Claude Code did not answer',
    // Outcomes
    'settings.claudeWindows.outcome.naturalWindowStarted': 'Your own request started the window',
    'settings.claudeWindows.outcome.triggerConfirmed': 'Started a window',
    'settings.claudeWindows.outcome.triggerUnverified':
        'Sent a request, but no new window appeared',
    'settings.claudeWindows.outcome.triggerFailed': 'The request failed',
    'settings.claudeWindows.outcome.renewalSkipped':
        'Skipped a renewal so the morning warm-up starts fresh',
    'settings.claudeWindows.outcome.weeklyLimit': 'Skipped: weekly limit used up',
    'settings.claudeWindows.outcome.authUnsupported': 'Skipped: unsupported sign-in',
    'settings.claudeWindows.outcome.missedWhileAsleep': 'Caught up after sleep',
    'settings.claudeWindows.outcome.missedSuffix': ' (planned for {{time}}, missed while asleep)',
    // Background job
    'settings.claudeWindows.background.unpackaged':
        'Development builds do not register the background job; windows are kept only while Caxri runs.',
    'settings.claudeWindows.background.unsupportedPlatform':
        'Windows are kept only while Caxri runs on this platform.',
    'settings.claudeWindows.background.registerFailed':
        'Could not register the background job; windows are kept only while Caxri runs.',
} as const;
