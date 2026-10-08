import type { GpuIncidentBudgetDiagnostic } from '@caxri/protocol';

import type { TerminalGpuAcceleration } from '../terminal/terminal-renderer';
import type { TerminalWebglSessionPolicy } from '../terminal/terminal-webgl-session-policy';
import { isWebgl2Available } from '../terminal/terminal-webgl-session-policy';
import { gpuRecoveryNotificationCoordinator } from './gpu-recovery-notifications';

/**
 * Distinct GPU incidents (Main-correlated `gpu.recoveryRequested` events) one Renderer session tolerates before every
 * Terminal stays on the DOM renderer. Three matches the per-pane retry budget so a session that keeps losing its GPU
 * process converges instead of re-arming WebGL on every tab switch.
 */
export const GPU_INCIDENT_PIN_THRESHOLD = 3;
/**
 * One physical GPU event drops every live WebGL context, so N split panes report N context losses within a few
 * milliseconds of each other. Losses inside this window count as one episode and only separate episodes advance the
 * `auto` budget. A context loss that happens without a GPU process exit carries no Main-owned correlation id, so the
 * window is the only way to tell "one incident hit three panes" from "three incidents".
 */
const GPU_CONTEXT_LOSS_EPISODE_WINDOW_MS = 2_000;
const MAX_REMEMBERED_GPU_INCIDENTS = 64;

type GpuIncidentBudgetTransition = Omit<GpuIncidentBudgetDiagnostic, 'kind' | 'diagnosticId'>;

interface GpuIncidentBudgetOptions {
    now?: () => number;
    /**
     * Receives only the pinned transition. Pinning is the one moment in this feature the user has to act on (GPU
     * acceleration is off for the rest of this window) so the notification layer subscribes to it directly instead of
     * inferring it from a per-pane status, which cannot tell "this pane fell back" from "the session gave up".
     */
    onPinned?: (transition: GpuIncidentBudgetTransition) => void;
    /**
     * Receives every session-level transition so the log can count pins and their cause; per-pane statuses cannot.
     */
    onTransition?: (transition: GpuIncidentBudgetTransition) => void;
    probeWebgl2(): boolean;
    threshold?: number;
}

export interface GpuIncidentBudget extends TerminalWebglSessionPolicy {
    contextLossEpisodeCount(): number;
    incidentCount(): number;
    /**
     * Counts one physical GPU incident once even though Main and every mounted pane observe it. Returns `true` exactly
     * when this incident pins the session so the caller can record the transition.
     */
    recordIncident(correlationId: string): boolean;
}

/**
 * Session-wide WebGL policy that survives Terminal pane remounts. Each mounted pane owns its own retry sequence and is
 * rebuilt on every tab switch, so a per-pane budget can never converge; this singleton is the only state that outlives
 * the pane. It is deliberately not persisted (VS Code removed its persisted `suggestedRendererType` for the same
 * reason): one bad GPU session must not degrade every later launch. Only an explicit preference change or manual retry
 * resets it, matching the #501 principle that GPU degradation stays user-controlled.
 *
 * `on` pins only after repeated Main-observed GPU process exits. `auto` additionally pins after repeated context-loss
 * episodes, which also cover contexts Chromium evicts without a GPU process exit; that is the one place where "let
 * Caxri decide" is allowed to decide against WebGL.
 */
export function createGpuIncidentBudget(options: GpuIncidentBudgetOptions): GpuIncidentBudget {
    const threshold = options.threshold ?? GPU_INCIDENT_PIN_THRESHOLD;
    const now = options.now ?? (() => Date.now());
    const incidentIds = new Set<string>();
    let appliedPreference: TerminalGpuAcceleration | undefined;
    let contextLossEpisodeCount = 0;
    let contextLossEpisodeStartedAt: number | undefined;
    let incidentCount = 0;
    let generation = 0;
    /**
     * Pure measurement: never reset with the budget and never consulted by `isPinned`, because a pin decision based on
     * context pressure would hide the very cause this count exists to reveal.
     */
    let liveWebglContextCount = 0;
    let webgl2ConfirmedGeneration: number | undefined;

    function isPinned(): boolean {
        if (incidentCount >= threshold) return true;
        return appliedPreference === 'auto' && contextLossEpisodeCount >= threshold;
    }

    function emit(
        transition: GpuIncidentBudgetTransition['transition'],
        cause: GpuIncidentBudgetTransition['cause'],
        correlationId?: string,
    ): void {
        const record: GpuIncidentBudgetTransition = {
            transition,
            cause,
            ...(correlationId && { correlationId }),
            incidentCount,
            contextLossEpisodeCount,
            threshold,
            preference: appliedPreference ?? null,
        };
        options.onTransition?.(record);
        // Routing both pin causes through the single emit point is what keeps the user notice tied to the transition
        // rather than to one of the two ways of reaching it.
        if (transition === 'pinned') options.onPinned?.(record);
    }

    function reset(): void {
        incidentIds.clear();
        contextLossEpisodeCount = 0;
        contextLossEpisodeStartedAt = undefined;
        incidentCount = 0;
        generation += 1;
    }

    return {
        resetForManualRetry(): void {
            emit('reset', 'manual-retry');
            reset();
        },
        /**
         * Every pane applies the preference on mount, so only a change between two applied values counts as the user
         * asking to try WebGL again; the first application of a session never resets anything.
         */
        applyPreference(preference: TerminalGpuAcceleration): void {
            const previous = appliedPreference;
            if (previous === undefined || previous === preference) {
                appliedPreference = preference;
                return;
            }
            // Decide and report the reset under the outgoing preference: whether a context-loss pin exists depends
            // on the preference being `auto`, so evaluating it after the switch would drop the reset of an `auto`
            // session that moves to `on`/`off` and fabricate one for a never-pinned `on` session moving to `auto`.
            if (isPinned()) emit('reset', 'preference-change');
            appliedPreference = preference;
            reset();
        },
        recordIncident(correlationId: string): boolean {
            if (incidentIds.has(correlationId)) return false;
            if (incidentIds.size >= MAX_REMEMBERED_GPU_INCIDENTS) {
                const oldest = incidentIds.values().next().value;
                if (oldest) incidentIds.delete(oldest);
            }
            incidentIds.add(correlationId);
            const wasPinned = isPinned();
            incidentCount += 1;
            generation += 1;
            const isPinnedNow = !wasPinned && isPinned();
            if (isPinnedNow) emit('pinned', 'gpu-incident', correlationId);
            return isPinnedNow;
        },
        recordContextLoss(): void {
            const at = now();
            if (
                contextLossEpisodeStartedAt !== undefined &&
                at - contextLossEpisodeStartedAt <= GPU_CONTEXT_LOSS_EPISODE_WINDOW_MS
            )
                return;
            contextLossEpisodeStartedAt = at;
            const wasPinned = isPinned();
            contextLossEpisodeCount += 1;
            if (!wasPinned && isPinned()) emit('pinned', 'context-loss');
        },
        contextLossEpisodeCount(): number {
            return contextLossEpisodeCount;
        },
        incidentCount(): number {
            return incidentCount;
        },
        isPinnedToDom: isPinned,
        liveWebglContextCount: () => liveWebglContextCount,
        recordWebglContextAcquired(): void {
            liveWebglContextCount += 1;
        },
        recordWebglContextReleased(): void {
            liveWebglContextCount = Math.max(0, liveWebglContextCount - 1);
        },
        /**
         * A positive probe creates and discards a real WebGL2 context, so during an incident storm every pane retry and
         * preference change would manufacture throwaway contexts that compete with live Terminals. Only a GPU incident
         * can turn a working GPU into a broken one, so a positive answer is cached per incident generation. A negative
         * answer is never cached: the GPU process comes back without any Renderer-visible event, a failed
         * `getContext('webgl2')` allocates nothing, and remembering it would make the backoff retries and every
         * later-mounted pane inherit a `false` observed during the restart gap until the next incident.
         */
        isWebgl2Available(): boolean {
            if (webgl2ConfirmedGeneration === generation) return true;
            const available = options.probeWebgl2();
            if (available) webgl2ConfirmedGeneration = generation;
            return available;
        },
    };
}

/**
 * The session budget reports its pin twice on purpose: once to the diagnostic log, which measures how often Caxri gives
 * up on WebGL, and once to the notification coordinator, which is the only surface that can tell the user it happened.
 */
export const gpuIncidentBudget = createGpuIncidentBudget({
    onPinned: (transition) =>
        gpuRecoveryNotificationCoordinator.notifySoftwareRenderingPinned(transition.correlationId),
    onTransition: (transition) =>
        globalThis.caxri.reportDiagnostic({
            kind: 'gpu-incident-budget',
            diagnosticId: crypto.randomUUID(),
            ...transition,
        }),
    probeWebgl2: isWebgl2Available,
});
