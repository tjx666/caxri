import type {
    TerminalGpuAcceleration,
    TerminalWebglSessionPolicy,
} from '../terminal/terminal-renderer';
import { isWebgl2Available } from '../terminal/terminal-renderer';

/**
 * Distinct GPU incidents (Main-correlated `gpu.recoveryRequested` events) one Renderer session tolerates before every
 * Terminal stays on the DOM renderer. Three matches the per-pane retry budget so a session that keeps losing its GPU
 * process converges instead of re-arming WebGL on every tab switch.
 */
export const GPU_INCIDENT_PIN_THRESHOLD = 3;
const MAX_REMEMBERED_GPU_INCIDENTS = 64;

interface GpuIncidentBudgetOptions {
    probeWebgl2(): boolean;
    threshold?: number;
}

export interface GpuIncidentBudget extends TerminalWebglSessionPolicy {
    incidentCount(): number;
    /**
     * Counts one physical GPU incident once even though Main and every mounted pane observe it. Returns `true` exactly
     * when this incident crosses the threshold so the caller can record the transition.
     */
    recordIncident(correlationId: string): boolean;
}

/**
 * Session-wide WebGL policy that survives Terminal pane remounts. Each mounted pane owns its own retry sequence and is
 * rebuilt on every tab switch, so a per-pane budget can never converge; this singleton is the only state that outlives
 * the pane. It is deliberately not persisted (VS Code removed its persisted `suggestedRendererType` for the same
 * reason): one bad GPU session must not degrade every later launch. Only an explicit preference change resets it,
 * matching the #501 principle that GPU degradation stays user-controlled.
 */
export function createGpuIncidentBudget(options: GpuIncidentBudgetOptions): GpuIncidentBudget {
    const threshold = options.threshold ?? GPU_INCIDENT_PIN_THRESHOLD;
    const incidentIds = new Set<string>();
    let appliedPreference: TerminalGpuAcceleration | undefined;
    let incidentCount = 0;
    let generation = 0;
    let cachedProbe: { generation: number; result: boolean } | undefined;

    function reset(): void {
        incidentIds.clear();
        incidentCount = 0;
        generation += 1;
    }

    return {
        /**
         * Every pane applies the preference on mount, so only a change between two applied values counts as the user
         * asking to try WebGL again; the first application of a session never resets anything.
         */
        applyPreference(preference: TerminalGpuAcceleration): void {
            const previous = appliedPreference;
            appliedPreference = preference;
            if (previous !== undefined && previous !== preference) reset();
        },
        recordIncident(correlationId: string): boolean {
            if (incidentIds.has(correlationId)) return false;
            if (incidentIds.size >= MAX_REMEMBERED_GPU_INCIDENTS) {
                const oldest = incidentIds.values().next().value;
                if (oldest) incidentIds.delete(oldest);
            }
            incidentIds.add(correlationId);
            incidentCount += 1;
            generation += 1;
            return incidentCount === threshold;
        },
        incidentCount(): number {
            return incidentCount;
        },
        isPinnedToDom(): boolean {
            return incidentCount >= threshold;
        },
        /**
         * Probing creates and discards a real WebGL2 context, so during an incident storm every pane retry and
         * preference change would manufacture throwaway contexts that compete with live Terminals. The answer only
         * changes when the GPU process does, so it is cached per incident generation.
         */
        isWebgl2Available(): boolean {
            if (cachedProbe?.generation !== generation)
                cachedProbe = { generation, result: options.probeWebgl2() };
            return cachedProbe.result;
        },
    };
}

export const gpuIncidentBudget = createGpuIncidentBudget({ probeWebgl2: isWebgl2Available });
