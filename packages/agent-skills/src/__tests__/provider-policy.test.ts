import { agentProviderIds } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    agentSkillProviderIds,
    agentSkillProviderIntegrations,
    requireAgentSkillProviderIntegration,
} from '../provider-policy';

describe('Agent skill provider policy', () => {
    it('makes one explicit support decision for every catalogued provider', () => {
        expect(new Set(Object.keys(agentSkillProviderIntegrations))).toEqual(
            new Set(agentProviderIds),
        );
        expect(agentSkillProviderIds).toEqual(
            agentProviderIds.filter(
                (provider) => agentSkillProviderIntegrations[provider] !== null,
            ),
        );
        for (const provider of agentSkillProviderIds)
            expect(requireAgentSkillProviderIntegration(provider)).toBeDefined();
    });

    it.each(['claude', 'codex', 'grok', 'antigravity'] as const)(
        'keeps %s skill integration enabled',
        (provider) => {
            expect(requireAgentSkillProviderIntegration(provider)).toBeDefined();
        },
    );
});
