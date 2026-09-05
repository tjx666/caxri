import { describe, expect, it, vi } from 'vitest';

import { createGpuIncidentBudget, GPU_INCIDENT_PIN_THRESHOLD } from './gpu-incident-budget';

describe('GPU incident budget', () => {
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
