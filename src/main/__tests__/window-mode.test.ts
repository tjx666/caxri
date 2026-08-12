import { describe, expect, it } from 'vitest';

import { resolveE2EWindowMode } from '../window-mode';

describe('resolveE2EWindowMode', () => {
    it('keeps focused E2E hidden unless the launch explicitly requests a visible desktop', () => {
        expect(resolveE2EWindowMode({ isE2E: true })).toBe('hidden');
        expect(resolveE2EWindowMode({ isE2E: true, requestedMode: 'hidden' })).toBe('hidden');
        expect(resolveE2EWindowMode({ isE2E: true, requestedMode: 'visible' })).toBe('visible');
        expect(resolveE2EWindowMode({ isE2E: true, requestedMode: 'invalid' })).toBe('hidden');
    });

    it('never lets the E2E-only environment hide a production window', () => {
        expect(resolveE2EWindowMode({ isE2E: false, requestedMode: 'hidden' })).toBe('visible');
    });
});
