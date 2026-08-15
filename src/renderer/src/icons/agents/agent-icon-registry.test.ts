import { agentProviderCatalog, agentProviderIds } from '@shared/agents';
import { describe, expect, it } from 'vitest';

import { agentIconRegistry, resolveAgentIcon } from './agent-icon-registry';

describe('agentIconRegistry', () => {
    it.each(agentProviderIds)('derives the %s label from the provider catalog', (provider) => {
        expect(resolveAgentIcon(provider)).toMatchObject({
            id: provider,
            label: agentProviderCatalog[provider].displayName,
        });
    });

    it.each([
        ['grok', 'Grok', 'mask-asset'],
        ['opencode', 'OpenCode', 'mask-asset'],
        ['shell', 'Shell', 'shell'],
        ['unknown', 'Unknown Agent', 'unknown'],
    ] as const)('keeps the local %s identity definition', (identity, label, kind) => {
        expect(resolveAgentIcon(identity)).toMatchObject({ id: identity, kind, label });
    });

    it('contains every supported and reserved identity exactly once', () => {
        expect(Object.keys(agentIconRegistry)).toEqual([
            ...agentProviderIds,
            'grok',
            'opencode',
            'shell',
            'unknown',
        ]);
    });

    it('uses the deliberate unknown fallback for future adapters', () => {
        expect(resolveAgentIcon('future-agent')).toBe(agentIconRegistry.unknown);
        expect(resolveAgentIcon()).toBe(agentIconRegistry.unknown);
    });
});
