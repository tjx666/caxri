import type { SessionHeat } from '@caxri/protocol';
import { SESSION_HEAT_THRESHOLDS } from '@caxri/protocol';

interface HeatState {
    /**
     * When the reading first reached the heat line in the current run of high samples; unset while it is below.
     */
    aboveSince?: number;
    /**
     * When a hot Session's reading first fell below the cool line; unset while it stays above.
     */
    belowSince?: number;
    cpuPercent: number;
    /**
     * Set once the Session is marked hot: the start of the episode.
     */
    hotSince?: number;
    peakCpuPercent: number;
}

export type SessionHeatChange =
    | { kind: 'raised'; cpuPercent: number; sessionId: string }
    | {
          durationMs: number;
          kind: 'cleared';
          peakCpuPercent: number;
          reason: 'recovered' | 'stopped';
          sessionId: string;
      };

/**
 * Decides which Sessions run hot from one CPU reading per Session per sample (see {@link SESSION_HEAT_THRESHOLDS}).
 * Pure: the caller supplies the clock and the readings, and gets back the episode transitions to log.
 */
export class SessionHeatTracker {
    private readonly states = new Map<string, HeatState>();

    constructor(
        private readonly thresholds: Record<
            keyof typeof SESSION_HEAT_THRESHOLDS,
            number
        > = SESSION_HEAT_THRESHOLDS,
    ) {}

    private clear(
        sessionId: string,
        state: HeatState,
        now: number,
        reason: 'recovered' | 'stopped',
    ): SessionHeatChange {
        this.states.delete(sessionId);
        return {
            durationMs: now - (state.hotSince ?? now),
            kind: 'cleared',
            peakCpuPercent: state.peakCpuPercent,
            reason,
            sessionId,
        };
    }

    /**
     * The Sessions currently marked hot, with their latest reading rounded to 10% (a tenth of a core), so an episode
     * holding steady publishes nothing.
     */
    hot(): Map<string, SessionHeat> {
        const hot = new Map<string, SessionHeat>();
        for (const [sessionId, state] of this.states)
            if (state.hotSince !== undefined)
                hot.set(sessionId, {
                    cpuPercent: Math.round(state.cpuPercent / 10) * 10,
                    since: state.hotSince,
                });
        return hot;
    }

    /**
     * True while any Session is tracked, so the sampler keeps running long enough to cool or drop it.
     */
    isTracking(): boolean {
        return this.states.size > 0;
    }

    /**
     * Folds one sample in. A Session absent from `readings` has nothing running any more: a hot one clears as
     * `stopped`.
     */
    update(readings: ReadonlyMap<string, number>, now: number): SessionHeatChange[] {
        const changes: SessionHeatChange[] = [];
        const { coolCpuPercent, coolMs, cpuPercent: heatLine, sustainMs } = this.thresholds;
        for (const [sessionId, cpuPercent] of readings) {
            const state = this.states.get(sessionId) ?? { cpuPercent, peakCpuPercent: 0 };
            state.cpuPercent = cpuPercent;
            if (state.hotSince === undefined) {
                if (cpuPercent < heatLine) {
                    this.states.delete(sessionId);
                    continue;
                }
                state.aboveSince ??= now;
                state.peakCpuPercent = Math.max(state.peakCpuPercent, cpuPercent);
                this.states.set(sessionId, state);
                if (now - state.aboveSince >= sustainMs) {
                    state.hotSince = state.aboveSince;
                    changes.push({ kind: 'raised', cpuPercent, sessionId });
                }
                continue;
            }
            state.peakCpuPercent = Math.max(state.peakCpuPercent, cpuPercent);
            if (cpuPercent >= coolCpuPercent) {
                state.belowSince = undefined;
                continue;
            }
            state.belowSince ??= now;
            if (now - state.belowSince >= coolMs) {
                changes.push(this.clear(sessionId, state, now, 'recovered'));
            }
        }
        for (const [sessionId, state] of this.states) {
            if (readings.has(sessionId)) continue;
            if (state.hotSince !== undefined)
                changes.push(this.clear(sessionId, state, now, 'stopped'));
            else this.states.delete(sessionId);
        }
        return changes;
    }
}
