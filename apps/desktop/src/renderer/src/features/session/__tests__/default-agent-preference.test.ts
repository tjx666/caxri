import { describe, expect, it, vi } from 'vitest';

vi.mock('../../settings/settings-client', () => ({
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
}));

import { shouldMakeDefault } from '../default-agent-preference';

describe('shouldMakeDefault', () => {
    it('writes the default only when the switch is on and the pick differs from it', () => {
        expect(shouldMakeDefault(true, 'codex', null)).toBe(true);
        expect(shouldMakeDefault(true, 'codex', 'claude')).toBe(true);
        expect(shouldMakeDefault(true, 'codex', undefined)).toBe(true);
    });

    it('writes nothing when the switch is off, the pick is already the default, or no Agent is chosen', () => {
        expect(shouldMakeDefault(false, 'codex', null)).toBe(false);
        expect(shouldMakeDefault(true, 'codex', 'codex')).toBe(false);
        expect(shouldMakeDefault(true, null, 'claude')).toBe(false);
    });
});
