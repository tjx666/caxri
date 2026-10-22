import type { AgentProvider } from '@caxri/protocol';

import { readLocalStorageJson, writeLocalStorageJson } from '../../lib/local-storage';
import { createStore } from '../../lib/store';

const DISMISSALS_STORAGE_KEY = 'caxri.usage.planPaceDismissals';

/**
 * The local day, per provider, on which the user dismissed the plan pace reminder. Remembered on this device so the
 * dismissal survives a restart or Renderer reload: the reminder is about today's spending, so it returns the next day,
 * not the next launch. The Chat composer's pace row and the status bar's usage chip read the same entry, so a dismissed
 * reminder neither reappears above the composer nor keeps the chip in the warning tone for the rest of the day.
 */
export type PlanPaceDismissals = Readonly<Partial<Record<AgentProvider, string>>>;

/**
 * The key a dismissal records: the local calendar day, so the reminder comes back after local midnight.
 */
export function planPaceDismissalDay(now: number): string {
    return new Date(now).toDateString();
}

/**
 * Keeps only string entries, so a corrupt stored value reads as "nothing dismissed" instead of throwing at load.
 */
export function parsePlanPaceDismissals(stored: unknown): PlanPaceDismissals {
    if (typeof stored !== 'object' || stored === null) return {};
    return Object.fromEntries(Object.entries(stored).filter(([, day]) => typeof day === 'string'));
}

export const usePlanPaceDismissals = createStore<{ dismissedOn: PlanPaceDismissals }>(
    'planPaceDismissals',
    () => ({ dismissedOn: parsePlanPaceDismissals(readLocalStorageJson(DISMISSALS_STORAGE_KEY)) }),
);

/**
 * A dismissal in another window arrives as a `storage` event; adopting it keeps every open window in step instead of
 * leaving the others on yesterday's warning until reload.
 */
if (typeof addEventListener === 'function') {
    addEventListener('storage', (event) => {
        if (event.key !== null && event.key !== DISMISSALS_STORAGE_KEY) return;
        usePlanPaceDismissals.setState({
            dismissedOn: parsePlanPaceDismissals(readLocalStorageJson(DISMISSALS_STORAGE_KEY)),
        });
    });
}

/**
 * Whether the provider's pace reminder was dismissed on the current local day.
 */
export function isPlanPaceDismissed(
    dismissedOn: PlanPaceDismissals,
    provider: AgentProvider,
    now: number,
): boolean {
    return dismissedOn[provider] === planPaceDismissalDay(now);
}

/**
 * Hides the provider's pace reminder, and the chip's pace warning, until the next local day.
 */
export function dismissPlanPace(provider: AgentProvider, now: number): void {
    const dismissedOn = {
        ...usePlanPaceDismissals.getState().dismissedOn,
        [provider]: planPaceDismissalDay(now),
    };
    usePlanPaceDismissals.setState({ dismissedOn });
    writeLocalStorageJson(DISMISSALS_STORAGE_KEY, dismissedOn);
}
