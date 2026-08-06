import { describe, expect, it } from 'vitest';

import { agentIconRegistry, resolveAgentIcon } from './agent-icon-registry';

describe('agentIconRegistry', () => {
    it.each([
        ['claude', 'Claude Code', 'color-asset'],
        ['codex', 'Codex', 'color-asset'],
        ['grok', 'Grok', 'mask-asset'],
        ['opencode', 'OpenCode', 'mask-asset'],
        ['shell', 'Shell', 'shell'],
        ['unknown', 'Unknown Agent', 'unknown'],
    ] as const)('maps %s to one shared identity definition', (identity, label, kind) => {
        expect(resolveAgentIcon(identity)).toMatchObject({ id: identity, kind, label });
    });

    it('contains every supported and reserved identity exactly once', () => {
        expect(Object.keys(agentIconRegistry)).toEqual([
            'claude',
            'codex',
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
