import type { ReloadEntry, ReloadStageName } from '../../shared/performance-monitor';

const MAX_ENTRIES = 10;
/**
 * A Renderer's `performance.timeOrigin` is taken when its document starts, so a startup frame that predates this load's
 * start by more than the clock skew between Main and the Renderer belongs to an earlier load.
 */
const CLOCK_SKEW_TOLERANCE_MS = 50;

type ReloadKind = ReloadEntry['kind'];
type ReloadFailure = NonNullable<ReloadEntry['failure']>;

/**
 * Renderer timestamps of the Workbench's own first-frame diagnostic, relative to its `timeOriginEpochMs`.
 */
interface StartupFrameTimes {
    firstFrameMs: number;
    loaderRemovedMs: number;
    timeOriginEpochMs: number;
}

/**
 * The state machine behind the Performance Monitor's reload view. Main feeds it the Workbench's load events with its
 * own clock and the Renderer's startup-frame diagnostic; it owns the last ten loads, newest first. Pure and clock
 * injected so the stage arithmetic is testable without Electron.
 *
 * `t0` is the main frame's `did-start-navigation`, which fires for a menu or `Cmd+R` reload as well as the monitor's
 * own button, so every reload is recorded no matter who triggered it.
 */
export class ReloadTimeline {
    private nextId = 0;
    private entries: ReloadEntry[] = [];
    private pendingKind: ReloadKind | undefined;

    constructor(private readonly now: () => number = Date.now) {}

    private inFlight(): ReloadEntry | undefined {
        const first = this.entries.at(0);
        return first?.outcome === 'loading' ? first : undefined;
    }

    private elapsed(entry: ReloadEntry): number {
        return Math.max(0, this.now() - entry.startedAt);
    }

    private swap(previous: ReloadEntry, next: ReloadEntry): void {
        this.entries = this.entries.map((entry) => (entry === previous ? next : entry));
    }

    list(): readonly ReloadEntry[] {
        return this.entries;
    }

    /**
     * Records which kind the next navigation is, for a reload Main starts itself; a reload nobody announced is a plain
     * `reload`.
     */
    announce(kind: ReloadKind): void {
        this.pendingKind = kind;
    }

    /**
     * A main-frame navigation began. Closes the load it supersedes: one that reached `did-finish-load` counts as done,
     * one that never did is dropped as an aborted attempt.
     */
    begin(): void {
        this.entries = this.entries.flatMap((entry) => {
            if (entry.outcome !== 'loading') return [entry];
            return entry.stages.didFinishLoad === undefined ? [] : [{ ...entry, outcome: 'done' }];
        });
        const entry: ReloadEntry = {
            id: this.nextId++,
            kind: this.pendingKind ?? 'reload',
            startedAt: this.now(),
            outcome: 'loading',
            stages: {},
        };
        this.pendingKind = undefined;
        this.entries = [entry, ...this.entries].slice(0, MAX_ENTRIES);
    }

    /**
     * Marks a Main-observed stage of the load in flight; ignored when none is in flight or the stage already happened.
     */
    mark(stage: Extract<ReloadStageName, 'didFinishLoad' | 'domReady'>): void {
        const current = this.inFlight();
        if (!current || current.stages[stage] !== undefined) return;
        this.swap(current, {
            ...current,
            stages: { ...current.stages, [stage]: this.elapsed(current) },
        });
    }

    /**
     * Records the Renderer's loader-removed and first-frame times for the load in flight, which closes it. Frames from
     * before the load started (the app's very first start, replayed) are ignored.
     */
    recordStartupFrame(frame: StartupFrameTimes): void {
        const current = this.inFlight();
        if (!current || frame.timeOriginEpochMs < current.startedAt - CLOCK_SKEW_TOLERANCE_MS)
            return;
        const toStage = (ms: number): number =>
            Math.max(0, frame.timeOriginEpochMs + ms - current.startedAt);
        this.swap(current, {
            ...current,
            outcome: 'done',
            stages: {
                ...current.stages,
                loaderRemoved: toStage(frame.loaderRemovedMs),
                firstFrame: toStage(frame.firstFrameMs),
            },
        });
    }

    /**
     * Ends the load in flight as failed. The stages reached so far stay, so the timeline shows where it stopped.
     */
    fail(failure: ReloadFailure): void {
        const current = this.inFlight();
        if (!current) return;
        this.swap(current, { ...current, outcome: 'failed', failure });
    }
}
