/**
 * Production tuning values for `AgentCoordinator`. They live beside the coordinator rather than inside it so the
 * coordinator module stays within the repository's file-size budget; tests override the timing ones through
 * `AgentCoordinatorOptions`.
 */
export const AGENT_METADATA_REFRESH_DELAY_MS = 2_000;
export const AGENT_COMPACTION_TIMEOUT_MS = 5 * 60_000;
export const AGENT_RUNNING_WATCHDOG_INTERVAL_MS = 5 * 60_000;
export const MAX_SHELL_PROMOTION_PROBES = 3;
