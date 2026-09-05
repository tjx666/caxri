/**
 * Ordered stages one automatic-naming attempt passes through, aligned with the awaits in
 * `SessionAutoNamingService#execute`. `complete` is a terminal marker rather than a measured stage.
 */
export const autoNamingStages = [
    'queued',
    'sourceRead',
    'ownershipCheck',
    'branchRead',
    'providerGeneration',
    'rename',
    'complete',
] as const;

export type AutoNamingStage = (typeof autoNamingStages)[number];

/**
 * Bounded result class for an attempt that did not throw.
 *
 * - `renamed`: the Session title was replaced.
 * - `blocked`: provider or ownership state forbids Caxri naming this Session right now.
 * - `skipped`: a gate, a throttle, or an unchanged title meant there was nothing to apply.
 * - `superseded`: a newer trigger or a launch identity change invalidated the in-flight attempt.
 * - `cancelled`: the attempt's abort signal fired.
 */
export type AutoNamingOutcome = 'renamed' | 'blocked' | 'skipped' | 'superseded' | 'cancelled';

/**
 * Closed reason enum. Every early return in `execute` maps to exactly one member so a record can distinguish "ran and
 * could not finish" from "never ran", which a stage name alone cannot express. `failed` is the one member `execute`
 * never emits: it belongs to the thrown-error path and exists so {@link AutoNamingReasonTally} counts failures in the
 * same closed vocabulary as everything else.
 */
export type AutoNamingReason =
    | 'aborted'
    | 'autoNamingStopped'
    | 'completed'
    | 'emptyTitle'
    | 'failed'
    | 'failureCooldown'
    | 'minimumInterval'
    | 'noUserMessages'
    | 'ownershipMissing'
    | 'providerTitleExplicit'
    | 'providerTitleUnverifiable'
    | 'renameDeclined'
    | 'resumeDeclined'
    | 'sourceUnavailable'
    | 'supersededByNewerTrigger'
    | 'targetIneligible'
    | 'transcriptGrowthBelowThreshold'
    | 'unchangedTitle';

/**
 * Reasons that fire on PTY-driven completions rather than on actual naming work, so their frequency is bounded only by
 * how often the Agent finishes a turn. They stay at `debug` even when the per-Session `info` budget is free.
 *
 * Server Core's sink runs at `info` with no override, so a `debug` record is dropped rather than deprioritized. That is
 * why every downgraded record still feeds {@link AutoNamingReasonTally}, whose counts ride along on the next record that
 * does reach `info`.
 */
export const highFrequencyAutoNamingReasons: ReadonlySet<AutoNamingReason> = new Set([
    'failureCooldown',
    'minimumInterval',
    'supersededByNewerTrigger',
]);

function reasonField(reason: AutoNamingReason): string {
    return `reason${reason[0].toUpperCase()}${reason.slice(1)}`;
}

/**
 * Per-Session aggregate over the closed reason enum, plus the slowest attempt seen.
 *
 * Required by the diagnostics contract in `project-architecture`: an event that is throttled to bound log volume can no
 * longer answer "how many", so it is paired with one aggregate per owning lifetime using flat, fixed-vocabulary field
 * names derived from the enum it counts. Without this, a Session whose every attempt exits through a `debug` reason
 * would leave the production log completely silent, which is the reported symptom behind issue #504.
 */
export class AutoNamingReasonTally {
    private readonly counts = new Map<AutoNamingReason, number>();
    private slowestMs = 0;

    record(reason: AutoNamingReason, durationMs: number): void {
        this.counts.set(reason, (this.counts.get(reason) ?? 0) + 1);
        this.slowestMs = Math.max(this.slowestMs, durationMs);
    }

    fields(): Record<string, number> {
        const fields: Record<string, number> = { slowestAttemptMs: this.slowestMs };
        for (const [reason, count] of this.counts) fields[reasonField(reason)] = count;
        return fields;
    }
}

const stageDurationFields: Partial<Record<AutoNamingStage, string>> = {
    queued: 'queuedMs',
    sourceRead: 'sourceReadMs',
    ownershipCheck: 'ownershipCheckMs',
    branchRead: 'branchReadMs',
    providerGeneration: 'providerGenerationMs',
    rename: 'renameMs',
};

/**
 * Accumulates per-stage durations for one automatic-naming attempt so a single terminal record can say where the time
 * went, instead of one log line per stage.
 *
 * The clock is the service's injected `now` rather than `performance.now()`: the same clock drives the failure cooldown
 * and the minimum generation interval, so sharing it keeps the recorded durations arithmetically consistent with the
 * gates a reader is comparing them against, and lets a test drive both from one fake clock. An attempt spans seconds,
 * which is far below the scale at which wall-clock adjustment would distort the reading.
 */
export class AutoNamingAttempt {
    private readonly durations = new Map<AutoNamingStage, number>();
    private currentStage: AutoNamingStage = 'queued';
    private stageStartedAt: number;

    /**
     * @param now The service's injected clock, shared with the cooldown and interval gates.
     * @param enqueuedAt When the trigger entered the queue, so `queued` covers the concurrency semaphore wait too.
     * @param ordinal 1-based count of attempts this Session slot has started, the per-lifetime aggregate that makes the
     *   real volume behind a repeated reason visible.
     */
    constructor(
        private readonly now: () => number,
        private readonly enqueuedAt: number,
        readonly ordinal: number,
    ) {
        this.stageStartedAt = enqueuedAt;
    }

    get stage(): AutoNamingStage {
        return this.currentStage;
    }

    enter(stage: AutoNamingStage): void {
        const at = this.now();
        this.durations.set(
            this.currentStage,
            (this.durations.get(this.currentStage) ?? 0) + (at - this.stageStartedAt),
        );
        this.currentStage = stage;
        this.stageStartedAt = at;
    }

    /**
     * Per-stage durations for the stages this attempt actually reached, plus the open stage's elapsed time. Stages that
     * never ran are omitted rather than reported as zero, so a reader can tell "instant" from "never entered".
     *
     * @param at One clock reading shared with {@link durationMs}.
     */
    stageFields(at: number): Record<string, number> {
        const fields: Record<string, number> = {};
        for (const [stage, duration] of this.durations) {
            const field = stageDurationFields[stage];
            if (field) fields[field] = duration;
        }
        const openField = stageDurationFields[this.currentStage];
        if (openField)
            fields[openField] =
                (this.durations.get(this.currentStage) ?? 0) + (at - this.stageStartedAt);
        return fields;
    }

    /**
     * @param at One clock reading shared with {@link stageFields} so the per-stage sum never exceeds the total.
     */
    durationMs(at: number): number {
        return at - this.enqueuedAt;
    }
}
