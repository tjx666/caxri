import { describe, expect, it } from 'vitest';

import { settingsSearchScope } from '../hooks/use-settings-search-query';

const untargeted = {
    agentActionsFocusRequest: undefined,
    agentExecutableFocusRequest: undefined,
    gitExclusionsFocusRequestId: undefined,
    notificationsFocusRequestId: undefined,
    rowFocusRequest: undefined,
    trustedDomainsFocusRequestId: undefined,
};

describe('settingsSearchScope', () => {
    it('keeps a query while the same list stays open', () => {
        expect(settingsSearchScope(untargeted, true)).toBe(settingsSearchScope(untargeted, true));
    });

    it('drops the query when the user leaves the Settings list', () => {
        expect(settingsSearchScope(untargeted, false)).not.toBe(
            settingsSearchScope(untargeted, true),
        );
    });

    it('drops the query on every targeted open, so the target row cannot be filtered out', () => {
        const before = settingsSearchScope(untargeted, true);
        const targetedOpens = [
            { agentActionsFocusRequest: { id: 1, provider: 'claude' as const } },
            { agentExecutableFocusRequest: { id: 1, provider: 'codex' as const } },
            { gitExclusionsFocusRequestId: 1 },
            { notificationsFocusRequestId: 1 },
            { rowFocusRequest: { id: 1, rowId: 'agents.claude.hooks' } },
            { trustedDomainsFocusRequestId: 1 },
        ];
        for (const open of targetedOpens)
            expect(settingsSearchScope({ ...untargeted, ...open }, true)).not.toBe(before);
    });

    it('tells a second open of the same target from the first', () => {
        expect(
            settingsSearchScope({ ...untargeted, notificationsFocusRequestId: 2 }, true),
        ).not.toBe(settingsSearchScope({ ...untargeted, notificationsFocusRequestId: 1 }, true));
    });
});
