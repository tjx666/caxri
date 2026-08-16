import { describe, expect, it } from 'vitest';

import { hasRequiredCapabilities } from '../principal';

describe('hasRequiredCapabilities', () => {
    it('lets an authenticated Desktop principal bypass explicit capability grants', () => {
        const context = {
            capabilities: ['desktop'],
            principal: { kind: 'desktop', id: 'desktop-1', generation: 1 },
        } as const;
        expect(hasRequiredCapabilities(context, ['projects.write', 'agents.control'])).toBe(true);
    });

    it('still enforces capabilities for a Desktop-kind principal missing the desktop capability', () => {
        const context = {
            capabilities: ['projects.read'],
            principal: { kind: 'desktop', id: 'desktop-1', generation: 1 },
        } as const;
        expect(hasRequiredCapabilities(context, ['desktop'])).toBe(false);
    });

    it('requires every listed capability for a non-desktop principal', () => {
        const context = {
            capabilities: ['projects.read', 'sessions.read'],
            principal: { kind: 'human-cli', id: 'cli-1' },
        } as const;
        expect(hasRequiredCapabilities(context, ['projects.read'])).toBe(true);
        expect(hasRequiredCapabilities(context, ['projects.read', 'sessions.write'])).toBe(false);
    });

    it('is trivially satisfied when no capability is required', () => {
        const context = {
            capabilities: [],
            principal: { kind: 'human-cli', id: 'cli-1' },
        } as const;
        expect(hasRequiredCapabilities(context, [])).toBe(true);
    });
});
