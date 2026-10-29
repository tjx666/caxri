/**
 * Agent secret events of the structured-log registry (`logEventCatalog.agentSecrets`). None carries a value or a secret
 * name: only the scope kind, closed statuses and sources, counts, and durations.
 */
export const agentSecretLogEvents = {
    /**
     * A secret was saved, with its scope `kind` and the closed `source` (`settings` or `request`).
     */
    saved: 'agent_secrets.saved',
    /**
     * An Agent raised a new request (`outcome: raised`), joined its own pending one (`joined`), or found the secret
     * already available (`available`).
     */
    requested: 'agent_secrets.requested',
    /**
     * A request left `pending` with its closed `status` and how long it waited (`durationMs`).
     */
    settled: 'agent_secrets.request_settled',
    /**
     * `caxri secret exec` resolved values, with the number of names asked for and found.
     */
    resolved: 'agent_secrets.resolved',
    /**
     * Deleting a Project dropped its scoped secrets, with the count removed, or failed to.
     */
    projectPruned: 'agent_secrets.project_pruned',
} as const;
