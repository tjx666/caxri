import { beforeEach, describe, expect, it } from 'vitest';

import {
    hideUsageGuardForADay,
    isUsageGuardHidden,
    useUsageGuardHiddenStore,
} from '../terminal-usage-guard-hidden';

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
});
