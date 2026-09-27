import { agentProviderCatalog, agentProviderIds } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

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
    it.each(['claude', 'codex'] as const)(
        'keeps %s as a full-color image by default (brand tone)',
        (identity) => {
            const icon = agentIconRegistry[identity];
            expect(resolveAgentIconRenderSource(icon)).toEqual({ kind: 'image', src: icon.src });
            expect(resolveAgentIconRenderSource(icon, 'brand')).toEqual({
                kind: 'image',
                src: icon.src,
            });
        },
    );

    it.each(['claude', 'codex'] as const)(
        'renders %s through its mono mask under state tone, tinting with currentColor like the other Agents',
        (identity) => {
            const icon = agentIconRegistry[identity];
            expect(icon.monoSrc).toBeTruthy();
            expect(icon.monoSrc).not.toBe(icon.src);
            expect(resolveAgentIconRenderSource(icon, 'state')).toEqual({
                kind: 'mask',
                src: icon.monoSrc,
            });
        },
    );

    it.each(['grok', 'opencode'] as const)(
        'keeps an already mask-asset identity (%s) on its mask regardless of tone',
        (identity) => {
            const icon = agentIconRegistry[identity];
            expect(resolveAgentIconRenderSource(icon, 'brand')).toEqual({
                kind: 'mask',
                src: icon.src,
            });
            expect(resolveAgentIconRenderSource(icon, 'state')).toEqual({
                kind: 'mask',
                src: icon.src,
            });
        },
    );

    it.each(['shell', 'unknown'] as const)(
        'has no image/mask source for %s — the caller renders its own lucide glyph',
        (identity) => {
            const icon = agentIconRegistry[identity];
            expect(resolveAgentIconRenderSource(icon, 'brand')).toBeUndefined();
            expect(resolveAgentIconRenderSource(icon, 'state')).toBeUndefined();
        },
    );
});
