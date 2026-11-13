import type {
    ServerEvent,
    SessionHeat,
    SessionKeychainPrompt,
    SessionSignal,
    SessionSignals,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import { SessionHeatTracker } from './session-heat';

interface SessionSignalsServiceOptions {
    logger: StructuredLogger;
    send: (event: ServerEvent) => void;
}

function areSignalsEqual(left: SessionSignals, right: SessionSignals): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Owns the sidebar's live per-Session markers: hot Sessions (fed by the resource monitor's samples) and open Keychain
 * dialogs (fed by `KeychainPromptWatcher`). Publishes one full snapshot on every change, and nothing while it is
 * unchanged, so a hot Session holding the same reading costs no event.
 */
export class SessionSignalsService {
    private heat = new Map<string, SessionHeat>();
    private readonly heatTracker = new SessionHeatTracker();
    private keychain: ReadonlyMap<string, SessionKeychainPrompt> = new Map();
    private last: SessionSignals = { sessions: {} };

    constructor(private readonly options: SessionSignalsServiceOptions) {}

    private publishIfChanged(): void {
        const next = this.snapshot();
        if (areSignalsEqual(next, this.last)) return;
        this.last = next;
        this.options.send({ event: 'terminal.sessionSignalsChanged', payload: next });
    }

    snapshot(): SessionSignals {
        const sessions: Record<string, SessionSignal> = {};
        for (const [sessionId, heat] of this.heat) sessions[sessionId] = { heat };
        for (const [sessionId, keychainPrompt] of this.keychain)
            sessions[sessionId] = { ...sessions[sessionId], keychainPrompt };
        return { sessions };
    }

    /**
     * True while the heat tracker still follows a Session, so the sampler keeps sampling until it cools or stops.
     */
    isTrackingHeat(): boolean {
        return this.heatTracker.isTracking();
    }

    /**
     * One resource sample: the summed CPU of every Session with something running.
     */
    updateHeat(readings: ReadonlyMap<string, number>, now: number): void {
        for (const change of this.heatTracker.update(readings, now)) {
            if (change.kind === 'raised')
                this.options.logger.write('info', logEventCatalog.terminal.sessionHeatRaised, {
                    fields: {
                        cpuPercent: Math.round(change.cpuPercent),
                        sessionId: change.sessionId,
                    },
                });
            else
                this.options.logger.write('info', logEventCatalog.terminal.sessionHeatCleared, {
                    durationMs: change.durationMs,
                    fields: {
                        peakCpuPercent: Math.round(change.peakCpuPercent),
                        reason: change.reason,
                        sessionId: change.sessionId,
                    },
                });
        }
        this.heat = this.heatTracker.hot();
        this.publishIfChanged();
    }

    updateKeychainPrompts(prompts: ReadonlyMap<string, SessionKeychainPrompt>): void {
        this.keychain = new Map(prompts);
        this.publishIfChanged();
    }
}
