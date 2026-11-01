import { readLocalStorageJson, writeLocalStorageJson } from '../../lib/local-storage';
import { createStore } from '../../lib/store';

const STORAGE_KEY = 'caxri.terminal.usageGuardHiddenUntil';
const HIDE_MS = 24 * 60 * 60 * 1000;

/**
 * Provider to the epoch millisecond until which its Terminal usage guard row stays hidden.
 */
type HiddenUntil = Readonly<Record<string, number>>;

function readStored(): HiddenUntil {
    const stored = readLocalStorageJson(STORAGE_KEY);
    if (typeof stored !== 'object' || stored === null) return {};
    return Object.fromEntries(
        Object.entries(stored).filter(
            (entry): entry is [string, number] => typeof entry[1] === 'number',
        ),
    );
}

/**
 * The per-device "Hide for a day" dismissals of the Terminal usage guard row, keyed by provider because the guard is a
 * property of the provider's account, not of one Terminal. Kept in this Renderer profile only: the row is
 * informational, so a dismissal does not need the Server round trip the composer's credits notice uses.
 */
export const useUsageGuardHiddenStore = createStore<{ hiddenUntil: HiddenUntil }>(
    'terminal-usage-guard-hidden',
    () => ({ hiddenUntil: readStored() }),
);

/**
 * Whether the provider's guard row is still inside its one-day dismissal.
 */
export function isUsageGuardHidden(
    hiddenUntil: HiddenUntil,
    provider: string,
    now: number,
): boolean {
    return (hiddenUntil[provider] ?? 0) > now;
}

/**
 * Hides the provider's guard row for a day from `now`, and drops expired entries while writing.
 */
export function hideUsageGuardForADay(provider: string, now: number): void {
    const live = Object.fromEntries(
        Object.entries(useUsageGuardHiddenStore.getState().hiddenUntil).filter(
            ([, until]) => until > now,
        ),
    );
    const hiddenUntil = { ...live, [provider]: now + HIDE_MS };
    useUsageGuardHiddenStore.setState({ hiddenUntil });
    writeLocalStorageJson(STORAGE_KEY, hiddenUntil);
}
