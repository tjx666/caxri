import { describe, expect, it, vi } from 'vitest';

import { createGpuIncidentBudget, GPU_INCIDENT_PIN_THRESHOLD } from '../gpu-incident-budget';

describe('GPU incident budget', () => {
    it('records an explicit retry reset and probes WebGL again instead of using a cached success', () => {
        const probeWebgl2 = vi.fn(() => true);
        const onTransition = vi.fn();
        const budget = createGpuIncidentBudget({ probeWebgl2, onTransition, threshold: 1 });
        budget.applyPreference('auto');
        budget.recordIncident('first');
        expect(budget.isWebgl2Available()).toBe(true);
        probeWebgl2.mockReturnValue(false);
        budget.resetForManualRetry();
        expect(budget.isPinnedToDom()).toBe(false);
        expect(budget.isWebgl2Available()).toBe(false);
        expect(onTransition).toHaveBeenLastCalledWith(
            expect.objectContaining({
                transition: 'reset',
                cause: 'manual-retry',
                incidentCount: 1,
                preference: 'auto',
            }),
        );
        budget.recordIncident('second');
        expect(budget.isPinnedToDom()).toBe(true);
    });
    it('pins the session to DOM after the threshold of distinct incidents and survives remounts', () => {
        const budget = createGpuIncidentBudget({ probeWebgl2: () => true });

        expect(budget.recordIncident('incident-1')).toBe(false);
        expect(budget.recordIncident('incident-1')).toBe(false);
        expect(budget.recordIncident('incident-2')).toBe(false);
        expect(budget.isPinnedToDom()).toBe(false);
        expect(budget.recordIncident('incident-3')).toBe(true);

        expect(budget.incidentCount()).toBe(GPU_INCIDENT_PIN_THRESHOLD);
        expect(budget.isPinnedToDom()).toBe(true);
        // Another pane mounting later applies the same preference and stays pinned.
        budget.applyPreference('on');
        budget.applyPreference('on');
        expect(budget.isPinnedToDom()).toBe(true);
        expect(budget.recordIncident('incident-4')).toBe(false);
        expect(budget.isPinnedToDom()).toBe(true);
    });

    it('resets only when the applied preference actually changes', () => {
        const budget = createGpuIncidentBudget({ probeWebgl2: () => true, threshold: 1 });
        budget.applyPreference('auto');
        budget.recordIncident('incident-1');
        expect(budget.isPinnedToDom()).toBe(true);

        budget.applyPreference('auto');
        expect(budget.isPinnedToDom()).toBe(true);

        budget.applyPreference('on');
        expect(budget.isPinnedToDom()).toBe(false);
        expect(budget.incidentCount()).toBe(0);
        expect(budget.recordIncident('incident-1')).toBe(true);
    });

    it('emits one pinned transition with the tripping incident and a reset when the preference changes', () => {
        const onPinned = vi.fn();
        const onTransition = vi.fn();
        const budget = createGpuIncidentBudget({ onPinned, onTransition, probeWebgl2: () => true });
        budget.applyPreference('on');

        budget.recordIncident('incident-1');
        budget.recordIncident('incident-2');
        expect(onTransition).not.toHaveBeenCalled();
        expect(onPinned).not.toHaveBeenCalled();
        expect(budget.recordIncident('incident-3')).toBe(true);
        expect(onTransition).toHaveBeenCalledWith({
            transition: 'pinned',
            cause: 'gpu-incident',
            correlationId: 'incident-3',
            incidentCount: 3,
            contextLossEpisodeCount: 0,
            threshold: GPU_INCIDENT_PIN_THRESHOLD,
            preference: 'on',
        });
        // The notification layer hears the same record, and only for the pinned transition.
        expect(onPinned).toHaveBeenCalledExactlyOnceWith(onTransition.mock.calls[0]?.[0]);
        // A later incident on an already pinned session is not a second transition.
        expect(budget.recordIncident('incident-4')).toBe(false);
        expect(onTransition).toHaveBeenCalledOnce();
        expect(onPinned).toHaveBeenCalledOnce();

        budget.applyPreference('auto');
        // The reset record names the preference the session was pinned under, not the incoming one.
        expect(onTransition).toHaveBeenLastCalledWith({
            transition: 'reset',
            cause: 'preference-change',
            incidentCount: 4,
            contextLossEpisodeCount: 0,
            threshold: GPU_INCIDENT_PIN_THRESHOLD,
            preference: 'on',
        });
        expect(budget.isPinnedToDom()).toBe(false);
        // Changing the preference of a session that never pinned is not a transition either.
        budget.applyPreference('on');
        expect(onTransition).toHaveBeenCalledTimes(2);
        // A reset is not a user-facing event: only the pin costs the user GPU acceleration.
        expect(onPinned).toHaveBeenCalledOnce();
    });

    it('reports the reset of a context-loss pin when auto leaves for on or off', () => {
        const onTransition = vi.fn();
        let now = 0;
        const budget = createGpuIncidentBudget({
            now: () => now,
            onTransition,
            probeWebgl2: () => true,
        });
        budget.applyPreference('auto');
        for (let episode = 0; episode < GPU_INCIDENT_PIN_THRESHOLD; episode += 1) {
            now += 5_000;
            budget.recordContextLoss();
        }
        expect(budget.isPinnedToDom()).toBe(true);

        budget.applyPreference('on');
        expect(onTransition).toHaveBeenLastCalledWith({
            transition: 'reset',
            cause: 'preference-change',
            incidentCount: 0,
            contextLossEpisodeCount: GPU_INCIDENT_PIN_THRESHOLD,
            threshold: GPU_INCIDENT_PIN_THRESHOLD,
            preference: 'auto',
        });
        expect(onTransition).toHaveBeenCalledTimes(2);
        expect(budget.isPinnedToDom()).toBe(false);
    });

    it('does not fabricate a reset when a never-pinned on session with old context losses moves to auto', () => {
        const onTransition = vi.fn();
        let now = 0;
        const budget = createGpuIncidentBudget({
            now: () => now,
            onTransition,
            probeWebgl2: () => true,
        });
        budget.applyPreference('on');
        for (let episode = 0; episode < 5; episode += 1) {
            now += 5_000;
            budget.recordContextLoss();
        }
        expect(budget.isPinnedToDom()).toBe(false);

        budget.applyPreference('auto');
        expect(onTransition).not.toHaveBeenCalled();
        expect(budget.isPinnedToDom()).toBe(false);
        expect(budget.contextLossEpisodeCount()).toBe(0);
    });

    it('pins auto after repeated context-loss episodes and counts one episode per GPU event', () => {
        let now = 0;
        const onPinned = vi.fn();
        const onTransition = vi.fn();
        const budget = createGpuIncidentBudget({
            now: () => now,
            onPinned,
            onTransition,
            probeWebgl2: () => true,
        });
        budget.applyPreference('auto');

        // Three split panes losing their contexts together are one episode.
        budget.recordContextLoss();
        budget.recordContextLoss();
        now = 1_500;
        budget.recordContextLoss();
        expect(budget.contextLossEpisodeCount()).toBe(1);

        now = 2_001;
        budget.recordContextLoss();
        now = 10_000;
        budget.recordContextLoss();
        expect(budget.contextLossEpisodeCount()).toBe(3);
        expect(budget.isPinnedToDom()).toBe(true);
        expect(onTransition).toHaveBeenCalledWith({
            transition: 'pinned',
            cause: 'context-loss',
            incidentCount: 0,
            contextLossEpisodeCount: 3,
            threshold: GPU_INCIDENT_PIN_THRESHOLD,
            preference: 'auto',
        });
        // A pin the user never sees reported is the gap this hook closes, whichever cause reached it.
        expect(onPinned).toHaveBeenCalledExactlyOnceWith(onTransition.mock.calls[0]?.[0]);
        expect(budget.recordIncident('incident-1')).toBe(false);
        expect(onTransition).toHaveBeenCalledOnce();
        expect(onPinned).toHaveBeenCalledOnce();
    });

    it('keeps on pinned only by Main-observed GPU incidents', () => {
        let now = 0;
        const budget = createGpuIncidentBudget({ now: () => now, probeWebgl2: () => true });
        budget.applyPreference('on');

        for (let episode = 0; episode < 5; episode += 1) {
            now += 5_000;
            budget.recordContextLoss();
        }
        expect(budget.contextLossEpisodeCount()).toBe(5);
        expect(budget.isPinnedToDom()).toBe(false);

        // Switching to auto afterwards starts from a clean budget rather than inheriting the old episodes.
        budget.applyPreference('auto');
        expect(budget.contextLossEpisodeCount()).toBe(0);
        expect(budget.isPinnedToDom()).toBe(false);
    });

    it('caches only a positive WebGL2 probe per GPU incident generation', () => {
        const probeWebgl2 = vi.fn(() => true);
        const budget = createGpuIncidentBudget({ probeWebgl2 });

        expect(budget.isWebgl2Available()).toBe(true);
        expect(budget.isWebgl2Available()).toBe(true);
        expect(probeWebgl2).toHaveBeenCalledOnce();

        // A new incident invalidates the positive answer.
        budget.recordIncident('incident-1');
        expect(budget.isWebgl2Available()).toBe(true);
        expect(probeWebgl2).toHaveBeenCalledTimes(2);

        budget.applyPreference('on');
        budget.applyPreference('auto');
        expect(budget.isWebgl2Available()).toBe(true);
        expect(probeWebgl2).toHaveBeenCalledTimes(3);
    });

    it('re-probes after a negative answer so the GPU process returning is observed', () => {
        const probeWebgl2 = vi.fn(() => false);
        const budget = createGpuIncidentBudget({ probeWebgl2 });
        budget.recordIncident('incident-1');

        // The GPU is still relaunching: every retry attempt and every later-mounted pane asks again.
        expect(budget.isWebgl2Available()).toBe(false);
        expect(budget.isWebgl2Available()).toBe(false);
        expect(probeWebgl2).toHaveBeenCalledTimes(2);

        // The GPU process is back; the next probe sees it without a new incident or preference change.
        probeWebgl2.mockReturnValue(true);
        expect(budget.isWebgl2Available()).toBe(true);
        expect(budget.isWebgl2Available()).toBe(true);
        expect(probeWebgl2).toHaveBeenCalledTimes(3);
    });
});
