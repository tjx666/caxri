import { createSharedLocalState } from '../../lib/local-storage';
import { createStore } from '../../lib/store';

const STORAGE_KEY = 'caxri.terminal.usageGuardHiddenUntil';
const HIDE_MS = 24 * 60 * 60 * 1000;

/**
 * Provider to the epoch millisecond until which its Terminal usage guard row stays hidden.
 */
type HiddenUntil = Readonly<Record<string, number>>;

function parseHiddenUntil(stored: unknown): HiddenUntil {
    if (typeof stored !== 'object' || stored === null) return {};
    return Object.fromEntries(
        Object.entries(stored).filter(
            (entry): entry is [string, number] => typeof entry[1] === 'number',
        ),
    );
}

/**
 * Shared by every window of the profile (docs/client-local-data.md). Keyed by provider, so a dismissal patches only its
 * own provider and keeps what other windows dismissed meanwhile.
 */
const sharedHidden = createSharedLocalState(STORAGE_KEY, parseHiddenUntil);

/**
 * The per-device "Hide for a day" dismissals of the Terminal usage guard row, keyed by provider because the guard is a
 * property of the provider's account, not of one Terminal. Kept in this Renderer profile only: the row is
 * informational, so a dismissal does not need the Server round trip the composer's credits notice uses.
 */
export const useUsageGuardHiddenStore = createStore<{ hiddenUntil: HiddenUntil }>(
    'terminal-usage-guard-hidden',
    (set) => {
        // Memory only, so another window's dismissal never writes back.
        sharedHidden.subscribe((hiddenUntil) => set({ hiddenUntil }));
        return { hiddenUntil: sharedHidden.read() };
    },
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
 * Hides the provider's guard row for a day from `now`, and drops expired entries while writing. The write patches the
 * stored record, so a dismissal another window made for a different provider survives.
 */
export function hideUsageGuardForADay(provider: string, now: number): void {
    const inMemory = useUsageGuardHiddenStore.getState().hiddenUntil;
    const fields: Record<string, number | undefined> = { [provider]: now + HIDE_MS };
    const known = { ...inMemory, ...sharedHidden.read() };
    for (const [other, until] of Object.entries(known)) {
        if (other !== provider && until <= now) fields[other] = undefined;
    }
    // The in-memory entries stay as a base so a window without storage still remembers its earlier dismissals.
    const merged = { ...inMemory, ...sharedHidden.patch(fields) };
    const hiddenUntil = Object.fromEntries(
        Object.entries(merged).filter(([, until]) => until > now),
    );
    useUsageGuardHiddenStore.setState({ hiddenUntil });
}
