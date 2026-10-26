/**
 * Claude 5-hour window keeper events of the structured-log registry (`logEventCatalog.claudeWindow` in
 * `../logging.ts`). None carries the prompt, the model's answer, the account email or organization, credentials,
 * environment values, or a transcript path: only the anonymous account key, planned and actual times, durations, and
 * closed enums.
 */
export const claudeWindowLogEvents = {
    /**
     * One keeper check finished, with its `source` (`timer`, `background`, `status`, `update`), the closed `decision`,
     * the resulting `status` and `reason`, for a check that could not start or read Claude Code its closed `failure`,
     * the planned time it served (`plannedAt`), how late it ran (`lateMs`), and its duration.
     */
    checked: 'claude_window.checked',
    /**
     * A decision with a closed `outcome` (`ClaudeWindowOutcome`), with the anonymous account key, plan type, the window
     * key it consumed, and for a trigger the number of confirmation reads and the time to the new reset.
     */
    outcome: 'claude_window.outcome',
    /**
     * Desktop registered, refreshed, or removed the background job, with a closed `outcome` and the number of wake
     * times.
     */
    backgroundJob: 'claude_window.background_job',
} as const;
