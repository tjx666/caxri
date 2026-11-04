/**
 * Delegated Session status copy shared by the Chat's Delegated Sessions strip, the timeline record, and the delegated
 * child's own row (`features/delegation/delegation-copy.ts`). Plain English with no window name: a receipt does not say
 * which usage window ran out, so no string claims one.
 */
export const delegation = {
    'delegation.copy.agentFallback': 'The Agent',
    'delegation.copy.starting': 'Starting {{provider}}',
    'delegation.copy.working': 'Working',
    'delegation.copy.collecting': 'Collecting the result',
    'delegation.copy.completed': 'Completed',
    'delegation.copy.noTask': 'No task details',
    'delegation.copy.needsInput': 'Needs your input',
    'delegation.copy.needsInputStartup':
        'Waiting for you to answer a startup prompt in the Session',
    'delegation.copy.needsInputRequest': 'Asked for a permission or an answer only you can give',
    'delegation.copy.takenOver': 'You took over this Session',
    'delegation.copy.takenOverDetail':
        'Its replies no longer go back to the Session that delegated it',
    'delegation.copy.stopped': 'Stopped',
    'delegation.copy.stoppedDetail': 'The Session that delegated it stopped this task',
    'delegation.copy.interrupted': 'Interrupted',
    'delegation.copy.interruptedHostReset': 'Caxri restarted while it was working',
    'delegation.copy.interruptedTargetChanged': 'Its Terminal was replaced or closed',
    'delegation.copy.sessionChanged': 'Its conversation was replaced',
    'delegation.copy.resultUnreadable': 'Finished, but its result could not be read',
    'delegation.copy.resultMissing': 'No answer was found for this task',
    'delegation.copy.resultUncorrelated': 'Caxri could not tell which answer belongs to this task',
    'delegation.copy.resultTooLong': 'The answer was too long to read back',
    'delegation.copy.failed': 'Failed',
    'delegation.copy.usageLimit': '{{provider}} usage limit used up',
    'delegation.copy.notSignedIn': "{{provider}} isn't signed in",
    'delegation.copy.couldNotStart': '{{provider}} could not start',
    'delegation.copy.hooksRequired': '{{provider}} needs lifecycle hooks turned on',
    'delegation.copy.hooksRequiredDetail':
        'Turn them on for {{provider}} in Settings, then delegate again',
    'delegation.copy.providerFailed': '{{provider}} stopped unexpectedly',
    'delegation.copy.outputLimit': '{{provider}} ran out of room',
    'delegation.copy.submissionUnconfirmed': 'The task may not have reached {{provider}}',
    'delegation.copy.notRun': 'A follow-up was not started',
    'delegation.copy.notRunBusy': 'Another task already holds this Session',
    'delegation.copy.notRunNotReady': 'The Session was not ready for it',
    'delegation.action.openSession': 'Open session',
    'delegation.preset.defaultModel': 'Provider default model',
    'delegation.preset.defaultEffort': 'Default effort',
    'delegation.preset.summary': 'Preset {{name}}: {{provider}}, {{model}}, {{effort}}',
    'delegation.strip.label': 'Delegated Sessions',
    'delegation.strip.count': '{{count}} delegated',
    'delegation.strip.needsInputOne': '{{count}} needs input',
    'delegation.strip.needsInputOther': '{{count}} need input',
    'delegation.strip.failed': '{{count}} failed',
    'delegation.strip.unavailable': 'Session unavailable',
    'delegation.strip.excerpt': 'Excerpt',
    'delegation.strip.prFilesOne': '{{count}} PR file',
    'delegation.strip.prFilesOther': '{{count}} PR files',
    'delegation.strip.openPullRequest': 'Open pull request #{{number}}',
    'delegation.record.label': 'Delegated to {{title}}',
    'delegation.record.openAria': 'Open {{title}}: {{status}}',
    'delegation.record.openAriaUnknown': 'Open {{title}}',
    'delegation.record.unavailable': 'Delegated to a Session that is no longer available',
    'delegation.origin.from': 'Delegated from {{title}}',
    'delegation.origin.autoReturn': 'The result goes back automatically',
    'delegation.origin.back': 'Back to {{title}}',
    'delegation.origin.hint':
        'Sending a message, Stop or Rewind here takes over this Session from {{title}}',
    'delegation.origin.takenOver': 'You took over this Session',
    'delegation.origin.takenOverDetail': 'its replies no longer go back to {{title}}',
    'delegation.divider.takenOver': 'You took over',
    'delegation.nextStep.signIn': 'Sign in',
    'delegation.nextStep.signInAria': 'Sign in to {{provider}} for the failed task in {{title}}',
    'delegation.nextStep.enableHooks': 'Enable hooks',
    'delegation.nextStep.enableHooksAria':
        'Open Settings to turn on {{provider}} lifecycle hooks for the failed task in {{title}}',
    'delegation.retry.action': 'Retry',
    'delegation.retry.actionAria': 'Retry the failed task in {{title}}',
    'delegation.retry.checking': 'Checking what can be retried',
    'delegation.retry.failedLabel': 'retry the failed delegated task',
    'delegation.retry.attempt': 'Attempt {{number}}',
    'delegation.retry.retried': 'Retried',
    'delegation.retry.mode.resume': 'Resume in the same conversation',
    'delegation.retry.mode.fresh': 'Start over in a new Session',
    'delegation.retry.confirm.resumeTitle': 'Retry in the same conversation?',
    'delegation.retry.confirm.resumeMessage':
        '{{provider}} continues this Session where it stopped. Changes it already made to files are not rolled back, and the failure stays in its history.',
    'delegation.retry.confirm.freshTitle': 'Retry in a new Session?',
    'delegation.retry.confirm.freshMessage':
        'Starts the task over in a new Session in {{project}}. The failed Session stays as it is. Changes it already made to files are not rolled back, and the new Session may repeat side effects the first attempt already had.',
    'delegation.retry.confirm.confirm': 'Retry',
    'delegation.retry.reason.human_input': 'You took over this Session',
    'delegation.retry.reason.target_changed': 'The Session changed after the failure',
    'delegation.retry.reason.session_changed': 'Its conversation was replaced',
    'delegation.retry.reason.target_busy': 'The Session is busy',
    'delegation.retry.reason.no_provider_session': 'There is no conversation to continue',
    'delegation.retry.reason.resume_unsupported': 'This Agent cannot continue a conversation',
    'delegation.retry.reason.caller_gone': 'The Agent that delegated this is no longer running',
    'delegation.retry.reason.worktree_gone': 'The worktree no longer exists',
    'delegation.retry.reason.already_retried': 'Already retried',
    'delegation.retry.reason.not_retryable': 'This failure cannot be retried',
    'delegation.retry.reason.no_reset_time': 'No reset time is known for this limit',
    'delegation.retry.reason.schedule_pending': 'A scheduled retry is waiting; cancel it first',
    'delegation.copy.retryPending': 'Retries at {{time}}',
    'delegation.strip.retryWaitingOne': '{{count}} retry waiting',
    'delegation.strip.retryWaitingOther': '{{count}} retries waiting',
    'delegation.retry.alreadyStarting': 'The retry is already starting',
    'delegation.retry.switchAction': 'Retry with {{provider}}',
    'delegation.retry.switchAria': 'Retry the failed task in {{title}} with {{provider}}',
    'delegation.retry.scheduleAction': 'Retry after {{time}}',
    'delegation.retry.scheduleAria': 'Retry the failed task in {{title}} after {{time}}',
    'delegation.retry.cancelAction': 'Cancel',
    'delegation.retry.cancelAria': 'Cancel the scheduled retry in {{title}}',
    'delegation.retry.cancelFailedLabel': 'cancel the scheduled retry',
    'delegation.retry.confirm.switchTitle': 'Retry with {{provider}}?',
    'delegation.retry.confirm.switchMessage':
        'Starts the task over with {{provider}} in a new Session in {{project}}, using its current delegation settings. The failed Session stays as it is. Changes it already made to files are not rolled back, and the new Session may repeat side effects the first attempt already had.',
    'delegation.retry.confirm.scheduleTitle': 'Retry after {{time}}?',
    'delegation.retry.confirm.scheduleResumeMessage':
        'At {{time}}, {{provider}} continues this Session where it stopped. The retry does not run if you take over this Session or its target changes before then; you can cancel it from the row until then.',
    'delegation.retry.confirm.scheduleFreshMessage':
        'At {{time}}, the task starts over in a new Session in {{project}}. The retry does not run if you take over this Session or its target changes before then; you can cancel it from the row until then.',
    'delegation.retry.confirm.scheduleConfirm': 'Schedule retry',
    'delegation.retry.outcome.caller_gone':
        'The scheduled retry did not run: the Agent that delegated this is no longer running',
    'delegation.retry.outcome.target_busy': 'The scheduled retry did not run: the Session is busy',
    'delegation.retry.outcome.target_changed':
        'The scheduled retry did not run: the Session changed',
    'delegation.retry.outcome.human_input':
        'The scheduled retry did not run: you took over this Session',
    'delegation.retry.outcome.worktree_gone':
        'The scheduled retry did not run: the worktree no longer exists',
    'delegation.retry.outcome.not_retryable':
        'The scheduled retry did not run: this failure cannot be retried',
    'delegation.retry.outcome.provider_guarded':
        'The scheduled retry did not run: the usage limit is still in effect',
    'delegation.retry.outcome.launch_failed':
        'The scheduled retry did not run: the Agent could not start',
    'delegation.retry.outcome.missed_window':
        'The scheduled retry did not run: it came due too long ago to start now',
    'delegation.retry.outcome.internal_error':
        'The scheduled retry did not run because of an internal error',
    'delegation.copy.askingParent': 'Asking the Agent that delegated it',
    'delegation.copy.askingYou': 'Waiting for your answer',
    'delegation.strip.askingOne': '{{count}} asking',
    'delegation.strip.askingOther': '{{count}} asking',
    'delegation.origin.waitingForParent': 'Waiting for {{title}} to answer',
    'delegation.origin.waitingForYou': 'Waiting for your answer',
    'delegation.question.answerAction': 'I will answer',
    'delegation.question.hint': 'Your answer goes to the Agent in this Session.',
    'delegation.question.placeholder': 'Type your answer',
    'delegation.question.send': 'Send answer',
    'delegation.question.alreadyAnswered': 'Already answered, your answer was not sent',
    'delegation.question.cancelled': 'The question was withdrawn, your answer was not sent',
    'delegation.question.escalatedReason': '{{title}} did not answer, so it is yours to answer',
    'delegation.question.sendFailedLabel': 'send the answer',
    'delegation.question.optionsLabel': 'Suggested answers',
    'delegation.copy.approvalParent': 'Waiting for the Agent that delegated it to approve',
    'delegation.copy.approvalYou': 'Waiting for your approval',
    'delegation.strip.approvalOne': '{{count}} waiting for your approval',
    'delegation.strip.approvalOther': '{{count}} waiting for your approval',
    'delegation.origin.waitingForApproval': 'Waiting for {{title}} to approve',
    'delegation.origin.waitingForYourApproval': 'Waiting for your approval',
    'delegation.approval.reason.covered': 'The Agent that delegated this did not decide in time',
    'delegation.approval.reason.disabled': 'Parent approval is turned off in Settings',
    'delegation.approval.reason.parent_not_chat':
        'The Agent that delegated this runs in a Terminal and cannot approve requests',
    'delegation.approval.reason.parent_provider':
        'The Agent that delegated this cannot approve requests',
    'delegation.approval.reason.parent_launch_unknown':
        'The Agent that delegated this could not be confirmed as running',
    'delegation.approval.reason.parent_mode_unresolved':
        'The permission level of the Agent that delegated this is not known',
    'delegation.approval.reason.parent_mode_unapplied':
        'The permission change of the Agent that delegated this has not taken effect yet',
    'delegation.approval.reason.parent_plan_mode': 'The Agent that delegated this is in plan mode',
    'delegation.approval.reason.parent_mode_insufficient':
        'The Agent that delegated this may not approve requests at its permission level',
    'delegation.approval.reason.ancestor_not_covering':
        'An Agent above the one that delegated this may not approve it',
    'delegation.approval.reason.ancestor_taken_over':
        'You took over an Agent in the chain that delegated this',
    'delegation.approval.reason.lineage_unproven': 'Who delegated this could not be confirmed',
    'delegation.approval.reason.taken_over': 'You already took over this Session',
    'delegation.approval.reason.turn_unproven':
        'This request does not belong to the delegated task',
    'delegation.approval.reason.kind_unsupported':
        'The Agent that delegated this may not decide this kind of request',
    'delegation.approval.reason.network':
        'The Agent that delegated this may not approve network access',
    'delegation.approval.reason.command_unproven': 'The command could not be shown in full',
    'delegation.approval.reason.path_missing': 'The files this would change are not known',
    'delegation.approval.reason.path_outside':
        "This would change files outside the Session's Project",
    'delegation.approval.reason.path_unproven': 'The files this would change could not be verified',
    'delegation.approval.reason.accept_not_offered': 'Approving is not offered for this request',
} as const;
