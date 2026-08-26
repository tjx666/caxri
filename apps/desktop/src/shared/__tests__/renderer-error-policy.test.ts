import { describe, expect, it } from 'vitest';

import { isBenignRendererErrorMessage } from '../renderer-error-policy';

describe('Renderer error policy', () => {
    it.each([
        'ResizeObserver loop completed with undelivered notifications.',
        'ResizeObserver loop limit exceeded',
    ])('classifies the browser ResizeObserver delivery warning as benign: %s', (message) => {
        expect(isBenignRendererErrorMessage(message)).toBe(true);
    });

    it.each(['ResizeObserver callback crashed', 'TypeError: failed to render', '', undefined])(
        'keeps real or unknown Renderer errors observable: %s',
        (message) => {
            expect(isBenignRendererErrorMessage(message)).toBe(false);
        },
    );
});
