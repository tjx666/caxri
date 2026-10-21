import { afterEach, describe, expect, it, vi } from 'vitest';

import { parsePlanPaceDismissals } from '../plan-pace-dismissals';

const STORAGE_KEY = 'caxri.usage.planPaceDismissals';
const NOW = new Date(2026, 9, 21, 18, 0).getTime();

/**
 * The suite runs under Vitest's `node` environment, so a test installs `window` and `localStorage` itself. The store
 * reads storage when its module loads, so each case loads a fresh copy, the way a restarted Renderer would.
 */
function stubStorage(entries: Map<string, string>): void {
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => entries.get(key) ?? null,
        setItem: (key: string, value: string) => {
            entries.set(key, value);
        },
    });
}

async function launch() {
    vi.resetModules();
    return import('../plan-pace-dismissals');
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('plan pace dismissals', () => {
    it('keeps a dismissal through a restart for the rest of the local day only', async () => {
        const entries = new Map<string, string>();
        stubStorage(entries);
        const first = await launch();
        first.dismissPlanPace('codex', NOW);

        const restarted = await launch();
        const { dismissedOn } = restarted.usePlanPaceDismissals.getState();
        expect(restarted.isPlanPaceDismissed(dismissedOn, 'codex', NOW + 3_600_000)).toBe(true);
        expect(restarted.isPlanPaceDismissed(dismissedOn, 'claude', NOW)).toBe(false);
        const tomorrow = new Date(2026, 9, 22, 0, 1).getTime();
        expect(restarted.isPlanPaceDismissed(dismissedOn, 'codex', tomorrow)).toBe(false);
    });

    it('reads a missing or corrupt entry as nothing dismissed', async () => {
        stubStorage(new Map([[STORAGE_KEY, '{not json']]));
        const { usePlanPaceDismissals } = await launch();
        expect(usePlanPaceDismissals.getState().dismissedOn).toEqual({});
        expect(parsePlanPaceDismissals({ codex: 3, claude: 'Wed Oct 21 2026' })).toEqual({
            claude: 'Wed Oct 21 2026',
        });
        expect(parsePlanPaceDismissals(null)).toEqual({});
    });
});
