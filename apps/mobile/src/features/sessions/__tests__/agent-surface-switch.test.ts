import { describe, expect, it } from 'vitest';

import { agentSurfaceSwitchTarget, segmentForAgentSurface } from '../agent-surface-switch';

describe('agentSurfaceSwitchTarget', () => {
    it('offers the other surface for a Chat-capable Agent', () => {
        expect(
            agentSurfaceSwitchTarget({ kind: 'claude', provider: 'claude', surface: 'chat' }),
        ).toBe('pty');
        expect(agentSurfaceSwitchTarget({ kind: 'codex', provider: 'codex' })).toBe('chat');
        expect(agentSurfaceSwitchTarget({ kind: 'grok', provider: 'grok' })).toBe('chat');
    });

    it('offers nothing for a Shell or an Agent not yet bound to a provider', () => {
        expect(agentSurfaceSwitchTarget(undefined)).toBeNull();
        expect(agentSurfaceSwitchTarget({ kind: 'shell' })).toBeNull();
        expect(agentSurfaceSwitchTarget({ kind: 'claude' })).toBeNull();
    });
});

describe('segmentForAgentSurface', () => {
    it('lands on the tab that shows the reopened Agent', () => {
        expect(segmentForAgentSurface('chat')).toBe('conversation');
        expect(segmentForAgentSurface('pty')).toBe('terminal');
    });
});
