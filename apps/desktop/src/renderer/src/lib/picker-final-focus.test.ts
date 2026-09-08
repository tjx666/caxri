import { afterEach, describe, expect, it } from 'vitest';

import { registerPickerFallbackFocus, resolvePickerFinalFocus } from './picker-final-focus';

/**
 * Runs under Vitest's `node` environment, so `Element` is modelled by the three fields the resolver reads:
 * connectivity, identity against the document body, and nothing else.
 */
function fakeElement(overrides: { isBody?: boolean; isConnected?: boolean } = {}): Element {
    const element = {
        isConnected: overrides.isConnected ?? true,
        ownerDocument: { body: undefined as unknown as HTMLElement },
    };
    element.ownerDocument.body = (overrides.isBody ? element : {}) as HTMLElement;
    return element as unknown as Element;
}

const fallback = { isConnected: true } as HTMLElement;
const registration = { unregister: undefined as (() => void) | undefined };

afterEach(() => {
    registration.unregister?.();
    registration.unregister = undefined;
});

describe('resolvePickerFinalFocus', () => {
    it('lets Base UI restore a connected non-body element that held focus before the picker opened', () => {
        registration.unregister = registerPickerFallbackFocus(() => fallback);
        expect(resolvePickerFinalFocus(fakeElement())).toBe(true);
    });

    it('routes to the workbench fallback when focus sat on the document body', () => {
        registration.unregister = registerPickerFallbackFocus(() => fallback);
        expect(resolvePickerFinalFocus(fakeElement({ isBody: true }))).toBe(fallback);
    });

    it('routes to the workbench fallback when the previous element left the DOM', () => {
        registration.unregister = registerPickerFallbackFocus(() => fallback);
        expect(resolvePickerFinalFocus(fakeElement({ isConnected: false }))).toBe(fallback);
    });

    it('declines to move focus when nothing is registered, instead of letting a stale element win', () => {
        expect(resolvePickerFinalFocus(null)).toBe(false);
    });

    it('does not let a stale unregister evict a newer fallback', () => {
        const first = registerPickerFallbackFocus(() => null);
        registration.unregister = registerPickerFallbackFocus(() => fallback);
        first();
        expect(resolvePickerFinalFocus(null)).toBe(fallback);
    });
});
