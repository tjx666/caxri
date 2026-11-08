import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installSharedProfile } from '../../../lib/__tests__/local-storage-profile';
import {
    hideUsageGuardForADay,
    isUsageGuardHidden,
    useUsageGuardHiddenStore,
} from '../terminal-usage-guard-hidden';

const STORAGE_KEY = 'caxri.terminal.usageGuardHiddenUntil';

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('Terminal usage guard dismissal', () => {
    beforeEach(() => {
        useUsageGuardHiddenStore.setState({ hiddenUntil: {} });
    });

    it('hides the provider for a day and then shows it again', () => {
        hideUsageGuardForADay('claude', 1_000);
        const { hiddenUntil } = useUsageGuardHiddenStore.getState();

        expect(isUsageGuardHidden(hiddenUntil, 'claude', 1_000 + 3_600_000)).toBe(true);
        expect(isUsageGuardHidden(hiddenUntil, 'claude', 1_000 + 86_400_000)).toBe(false);
    });

    it('leaves other providers visible and drops expired entries', () => {
        hideUsageGuardForADay('codex', 0);
        hideUsageGuardForADay('claude', 90_000_000);
        const { hiddenUntil } = useUsageGuardHiddenStore.getState();

        expect(isUsageGuardHidden(hiddenUntil, 'codex', 90_000_000)).toBe(false);
        expect(Object.keys(hiddenUntil)).toEqual(['claude']);
    });

    it("keeps another window's dismissal of a different provider when this window writes", () => {
        const profile = installSharedProfile();
        // Another window dismissed Codex after this window loaded.
        profile.entries.set(STORAGE_KEY, JSON.stringify({ codex: 500_000 }));

        hideUsageGuardForADay('claude', 1_000);

        expect(JSON.parse(profile.entries.get(STORAGE_KEY) ?? 'null')).toEqual({
            codex: 500_000,
            claude: 1_000 + 86_400_000,
        });
        expect(Object.keys(useUsageGuardHiddenStore.getState().hiddenUntil)).toEqual(
            expect.arrayContaining(['claude', 'codex']),
        );
    });
});
