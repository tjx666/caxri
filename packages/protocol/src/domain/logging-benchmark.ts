/**
 * Benchmark events of the structured-log registry (`logEventCatalog.benchmark` in `./logging.ts`). None carries the
 * prompt, an Agent's answer, a diff, or check output: only identifiers, providers, models, closed reasons, counts, and
 * durations.
 */
export const benchmarkLogEvents = {
    /**
     * A run was accepted, with its Entry and Attempt counts, workspace kind, and whether a check or judge is set.
     */
    runStarted: 'benchmark.run_started',
    /**
     * One Attempt reached a final status, with its provider, model, effort, closed `failureReason`, duration, step
     * count, token total, cost source, time to first token, and compaction count.
     */
    attemptFinished: 'benchmark.attempt_finished',
    /**
     * A run reached `completed` or `cancelled`, with its per-status Attempt counts and total duration.
     */
    runFinished: 'benchmark.run_finished',
    /**
     * The judge pass finished, with a closed `outcome` (`completed`, `failed`, `unparsable`) and its duration.
     */
    judgeFinished: 'benchmark.judge_finished',
    /**
     * A catalog probe of one provider finished, with a closed `status` and the number of models it listed.
     */
    catalogProbed: 'benchmark.catalog_probed',
    /**
     * Server start found runs a previous Server left unfinished and closed their Attempts as `serverRestarted`.
     */
    interruptedRunsClosed: 'benchmark.interrupted_runs_closed',
} as const;
