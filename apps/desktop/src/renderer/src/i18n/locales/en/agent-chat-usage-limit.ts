/**
 * Agent Chat's usage-limit surfaces: the recovery card on a turn a used-up plan limit failed (issue #2581), and the
 * composer's weekly usage guard (issue #2580).
 */
export const agentChatUsageLimit = {
    'agentChat.usageLimit.session': '{{provider}} used up its 5-hour limit',
    'agentChat.usageLimit.weekly': '{{provider}} used up its weekly limit',
    'agentChat.usageLimit.unknown': '{{provider}} used up its usage limit',
    'agentChat.usageLimit.guardStopped':
        '{{provider}} is close to its weekly limit, so Caxri stopped this turn',
    'agentChat.usageLimit.continueIn': 'Continue in {{provider}}',
    'agentChat.usageLimit.continueElsewhere': 'Continue in another Agent',
    'agentChat.usageLimit.chooseAgent': 'Choose another Agent',
    'agentChat.usageLimit.continueTooltip':
        'Opens a new Session in this Project where {{provider}} picks the work up from this conversation',
    'agentChat.usageLimit.noTarget': 'No other Agent can take this over',
    'agentChat.continueMenu.label': 'Continue in Another Agent',
    'agentChat.continueMenu.needsChatReason':
        'Open the Agent as Chat to continue it in another Agent',
    'agentChat.continueMenu.noConversationReason': 'This Agent has no conversation yet',
    'agentChat.usageLimit.continueFailed': "Couldn't continue in another Agent",
    'agentChat.usageLimit.auto.waiting': 'Continues automatically at {{time}} (in {{duration}})',
    'agentChat.usageLimit.auto.continuing': 'Continuing automatically…',
    'agentChat.usageLimit.auto.continued': 'Continued automatically at {{time}}',
    'agentChat.usageLimit.auto.missed': 'The limit has reset',
    'agentChat.usageLimit.auto.skipped.resetUnknown':
        "Won't continue automatically: no reset time was reported",
    'agentChat.usageLimit.auto.skipped.resetTooFar':
        "Won't continue automatically: the limit resets more than 24 hours from now",
    'agentChat.usageLimit.auto.skipped.attemptsUsed':
        'Stopped continuing automatically after {{count}} tries into the limit',
    'agentChat.usageLimit.auto.skipped.usageGuard':
        "Won't continue automatically while the weekly limit is nearly reached",
    'agentChat.usageLimit.auto.continueNow': 'Continue now',
    'agentChat.usageLimit.auto.continue': 'Continue',
    'agentChat.usageLimit.auto.cancel': 'Cancel',
    'agentChat.usageLimit.auto.cancelTooltip': 'Stop waiting; the Chat stays as it is',
    'agentChat.usageLimit.auto.continueFailed': "Couldn't continue this Chat",
    'agentChat.usageLimit.auto.cancelFailed': "Couldn't cancel the automatic continuation",
    'agentChat.usageLimit.unavailable.current': 'This Chat',
    'agentChat.usageLimit.unavailable.notInstalled': 'Not installed',
    'agentChat.usageLimit.unavailable.unsupported': 'No Chat support',
    'agentChat.usageLimit.unavailable.usageLimited': 'Close to its weekly limit',
    'agentChat.usageLimit.unavailable.usageLimitedUntil': 'Close to its weekly limit, {{reset}}',
    'agentChat.message.sendBlockedUsageGuard': 'Weekly limit nearly reached. Hand off below',
    'agentChat.queue.pausedUsageGuard': 'Queue paused · weekly limit nearly reached',
    'agentChat.creditsNotice.credits':
        '{{provider}} weekly usage at {{percent}}%: requests continue on credits',
    'agentChat.creditsNotice.creditsLeft':
        '{{provider}} weekly usage at {{percent}}%: requests continue on credits, {{balance}} left',
    'agentChat.creditsNotice.extraUsage':
        '{{provider}} weekly usage at {{percent}}%: requests continue on extra usage',
    'agentChat.creditsNotice.extraUsageLeft':
        '{{provider}} weekly usage at {{percent}}%: requests continue on extra usage, {{balance}} left this month',
    'agentChat.creditsNotice.detail':
        "New requests spend the account's credits until the weekly limit resets ({{reset}}).",
    'agentChat.creditsNotice.dismiss': 'Hide for a day',
    'agentChat.usageGuard.headline': '{{provider}} is at {{percent}}% of its weekly limit',
    'agentChat.usageGuard.detail':
        'Caxri paused new requests, {{reset}}, so you can hand this work off before it runs out.',
    'agentChat.usageGuard.generate': 'Generate hand-off',
    'agentChat.usageGuard.generateTooltip':
        '{{provider}} writes a hand-off document with the last of its weekly allowance. Once per account until the weekly limit resets',
    'agentChat.usageGuard.generating': 'Writing the hand-off…',
    'agentChat.usageGuard.used': 'This account already wrote a hand-off this week',
    'agentChat.usageGuard.generateFailed': "Couldn't generate a hand-off",
    'agentChat.usageGuard.openElsewhere': 'Open in another Agent',
    'agentChat.usageGuard.continueAnyway': 'Continue anyway',
    'agentChat.usageGuard.continueAnywayTooltip':
        'Resume requests on this {{provider}} account until the weekly limit resets. This spends the allowance reserved for a hand-off',
    'agentChat.usageGuard.continueAnywayFailed': "Couldn't resume requests",
    'agentChat.usageGuard.document': 'Hand-off document',
    'agentChat.usageGuard.copy': 'Copy hand-off',
    'agentChat.usageGuard.failed.rejected':
        'The hand-off was refused. Open in another Agent still carries this conversation',
    'agentChat.usageGuard.failed.timeout':
        'The hand-off timed out. Open in another Agent still carries this conversation',
    'agentChat.usageGuard.failed.unavailable':
        'The hand-off could not start. Open in another Agent still carries this conversation',
    'agentChat.usageGuard.failed.empty':
        'The hand-off came back empty. Open in another Agent still carries this conversation',
    'agentChat.usageGuard.continuedIn': 'Continued in',
} as const;
