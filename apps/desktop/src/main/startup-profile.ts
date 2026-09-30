import type { StartupFrameDiagnostic } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

/**
 * Launch milestones in the order a healthy cold start reaches them. Each value is milliseconds since the Main process
 * time origin, so one record answers both "how long did launch take" and "which phase ate it".
 */
const startupMilestones = [
    'mainModule',
    'appReady',
    'serverAttached',
    'windowCreated',
    'readyToShow',
    'windowShown',
    'rendererReady',
    'loaderRemoved',
    'firstFrame',
] as const;

export type StartupMilestone = (typeof startupMilestones)[number];

export type StartupProfileFields = Record<`${StartupMilestone}Ms`, number | null> & {
    documentVisible: boolean;
};

/**
 * Collects one Desktop launch's milestones and yields the summary exactly once, when the Renderer reports its first
 * visible frame. A Renderer reload or a later window never reopens the profile: only the launch itself is measured.
 */
export class StartupProfile {
    private readonly marks = new Map<StartupMilestone, number>();
    private isReported = false;

    /**
     * @param timeOriginEpochMs Main's `performance.timeOrigin`, used to rebase Renderer timestamps onto Main's clock.
     */
    constructor(
        private readonly timeOriginEpochMs: number,
        private readonly logger: () => StructuredLogger | undefined = () => {},
        private readonly now: () => number = () => performance.now(),
    ) {}

    /**
     * Records a milestone the first time it is reached; later occurrences belong to recovery, not to launch.
     */
    mark(milestone: StartupMilestone, at: number = this.now()): void {
        if (this.isReported || this.marks.has(milestone)) return;
        this.marks.set(milestone, Math.round(at));
    }

    /**
     * Closes the profile with the Renderer's frame report and writes the `app.startup_profile` record. Returns
     * `undefined` when the profile was already reported.
     */
    complete(frame: StartupFrameDiagnostic): StartupProfileFields | undefined {
        if (this.isReported) return undefined;
        const offset = frame.timeOriginEpochMs - this.timeOriginEpochMs;
        this.mark('loaderRemoved', offset + frame.loaderRemovedMs);
        this.mark('firstFrame', offset + frame.firstFrameMs);
        this.isReported = true;
        const fields = { documentVisible: frame.documentVisible } as StartupProfileFields;
        for (const milestone of startupMilestones)
            fields[`${milestone}Ms`] = this.marks.get(milestone) ?? null;
        this.logger()?.write('info', logEventCatalog.app.startupProfile, {
            durationMs: fields.firstFrameMs ?? undefined,
            fields,
        });
        return fields;
    }
}
