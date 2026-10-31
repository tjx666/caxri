import { agentProviderCatalog, agentProviderIds } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { useLocaleStore } from '../../i18n/locale-store';
import {
    agentIconRegistry,
    resolveAgentIcon,
    resolveAgentIconRenderSource,
} from './agent-icon-registry';

describe('agentIconRegistry', () => {
    it.each(agentProviderIds)('derives the %s label from the provider catalog', (provider) => {
        expect(resolveAgentIcon(provider)).toMatchObject({
            id: provider,
            label: agentProviderCatalog[provider].displayName,
        });
    });

    it.each([
        ['grok', 'Grok Build', 'mask-asset'],
        ['opencode', 'OpenCode', 'mask-asset'],
        ['shell', 'Shell', 'shell'],
        ['unknown', 'Unknown Agent', 'unknown'],
    ] as const)('keeps the local %s identity definition', (identity, label, kind) => {
        expect(resolveAgentIcon(identity)).toMatchObject({ id: identity, kind, label });
    });

    it('names the fallback Agent in the interface language', () => {
        useLocaleStore.setState({ locale: 'zh-CN' });
        try {
            expect(resolveAgentIcon('unknown').label).toBe('未知 Agent');
        } finally {
            useLocaleStore.setState({ locale: 'en' });
        }
        expect(resolveAgentIcon(undefined).label).toBe('Unknown Agent');
    });

    it('contains every supported and reserved identity exactly once', () => {
        expect(Object.keys(agentIconRegistry)).toEqual([
            ...agentProviderIds,
            'opencode',
            'shell',
            'unknown',
        ]);
    });

    it('draws the full-bleed Codex mark smaller so it matches the shorter Claude Code glyph', () => {
        expect(agentIconRegistry.codex.opticalScale).toBeLessThan(1);
        expect(agentIconRegistry.claude.opticalScale).toBeUndefined();
    });

    it('uses the deliberate unknown fallback for future adapters', () => {
        expect(resolveAgentIcon('future-agent')).toBe(agentIconRegistry.unknown);
        expect(resolveAgentIcon()).toBe(agentIconRegistry.unknown);
    });
});

describe('resolveAgentIconRenderSource', () => {
    it.each(['claude', 'codex', 'antigravity'] as const)(
        'keeps %s as a full-color image',
        (identity) => {
            const icon = agentIconRegistry[identity];
            expect(resolveAgentIconRenderSource(icon)).toEqual({ kind: 'image', src: icon.src });
        },
    );

    it.each(['grok', 'opencode'] as const)(
        'tints the mask-asset %s identity with currentColor',
        (identity) => {
            const icon = agentIconRegistry[identity];
            expect(resolveAgentIconRenderSource(icon)).toEqual({ kind: 'mask', src: icon.src });
        },
    );

    it.each(['shell', 'unknown'] as const)(
        'has no image/mask source for %s: the caller renders its own lucide glyph',
        (identity) => {
            expect(resolveAgentIconRenderSource(agentIconRegistry[identity])).toBeUndefined();
        },
    );
});
