import { describe, expect, it } from 'vitest';

import {
    agentActionsSettingsFileSchema,
    agentActionsSettingsSchema,
    defaultAgentActionsSettings,
    MAX_RECENT_AGENT_ACTIONS,
    pushRecentAgentAction,
    resolveRecentAgentActions,
} from '../agent-action-settings';

describe('Agent Action recent settings', () => {
    it('moves successful actions to the front, deduplicates, and enforces the MRU limit', () => {
        let settings = structuredClone(defaultAgentActionsSettings);
        for (let index = 0; index < MAX_RECENT_AGENT_ACTIONS + 2; index += 1) {
            settings = pushRecentAgentAction(settings, `/action-${index}`);
        }
        settings = pushRecentAgentAction(settings, '/action-5');

        expect(settings.recent.invocations).toEqual([
            '/action-5',
            '/action-9',
            '/action-8',
            '/action-7',
            '/action-6',
            '/action-4',
            '/action-3',
            '/action-2',
        ]);
    });

    it('reconciles history against the current catalog without deleting unavailable identities', () => {
        let settings = structuredClone(defaultAgentActionsSettings);
        settings = pushRecentAgentAction(settings, '/alpha');
        settings = pushRecentAgentAction(settings, '$beta');
        const alpha = { invocation: '/alpha', label: 'Alpha' };
        const beta = { invocation: '$beta', label: 'Beta' };

        expect(resolveRecentAgentActions([alpha], settings)).toEqual([alpha]);
        expect(resolveRecentAgentActions([alpha, beta], settings)).toEqual([beta, alpha]);
    });

    it('keeps provider histories independent', () => {
        const codex = pushRecentAgentAction(defaultAgentActionsSettings, '/status');
        const claude = pushRecentAgentAction(defaultAgentActionsSettings, '/context');

        expect(codex.recent.invocations).toEqual(['/status']);
        expect(claude.recent.invocations).toEqual(['/context']);
    });

    it('falls back to empty history for damaged or unknown file versions', () => {
        for (const recent of [
            { version: 0, invocations: ['/status'] },
            { version: 1, invocations: ['/two words'] },
            { version: 1, invocations: ['/status', '/status'] },
        ]) {
            expect(agentActionsSettingsFileSchema.parse({ items: {}, recent }).recent).toEqual({
                version: 1,
                invocations: [],
            });
            expect(agentActionsSettingsSchema.safeParse({ items: {}, recent }).success).toBe(false);
        }
    });
});
