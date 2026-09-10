import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    isRestoringPickerFocus,
    registerPickerFallbackFocus,
    resolvePickerFinalFocus,
    restorePickerFocus,
} from './picker-final-focus';

/**
 * Runs under Vitest's `node` environment, so `Element` is modelled by the three fields the resolver reads:
 * connectivity, identity against the document body, and nothing else.
 */
function fakeElement(overrides: { isBody?: boolean; isConnected?: boolean } = {}): HTMLElement {
    const element = {
        isConnected: overrides.isConnected ?? true,
        ownerDocument: { body: undefined as unknown as HTMLElement },
    };
    element.ownerDocument.body = (overrides.isBody ? element : {}) as HTMLElement;
    return element as unknown as HTMLElement;
}

const fallback = { isConnected: true } as HTMLElement;
const registration = { unregister: undefined as (() => void) | undefined };

afterEach(() => {
    registration.unregister?.();
    registration.unregister = undefined;
});

describe('resolvePickerFinalFocus', () => {
    it('returns the exact connected opening element instead of delegating to focus history', () => {
        registration.unregister = registerPickerFallbackFocus(() => fallback);
        const element = fakeElement();
        expect(resolvePickerFinalFocus(element)).toBe(element);
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

    it('rejects a disconnected workbench fallback', () => {
        registration.unregister = registerPickerFallbackFocus(() =>
            fakeElement({ isConnected: false }),
        );
        expect(resolvePickerFinalFocus(null)).toBe(false);
    });
});

/**
 * Models native synchronous focus dispatch without rendering React components.
 */
function focusFixture() {
    const body = fakeElement({ isBody: true });
    const document_ = { body, activeElement: body };
    const target = Object.assign(fakeElement(), {
        ownerDocument: document_,
        focus: vi.fn(() => {
            document_.activeElement = target;
            expect(isRestoringPickerFocus(target)).toBe(true);
        }),
    });
    const popup = Object.assign(fakeElement(), {
        ownerDocument: document_,
        contains: (element: Node | null) => element === popup,
    });
    document_.activeElement = popup;
    return { doc: document_, popup, target };
}

describe('restorePickerFocus', () => {
    it('restores after modal cleanup and marks only the synchronous restoration event', async () => {
        const { popup, target } = focusFixture();
        restorePickerFocus(target, popup);
        expect(target.focus).not.toHaveBeenCalled();
        await Promise.resolve();
        expect(target.focus).toHaveBeenCalledWith({ preventScroll: true });
        expect(isRestoringPickerFocus(target)).toBe(false);
    });

    it('preserves focus handed to a different surface during closing', async () => {
        const { doc, popup, target } = focusFixture();
        restorePickerFocus(target, popup);
        const destination = fakeElement();
        doc.activeElement = destination;
        await Promise.resolve();
        expect(doc.activeElement).toBe(destination);
        expect(target.focus).not.toHaveBeenCalled();
    });

    it('uses the current workbench when the original target disappears before cleanup', async () => {
        const { doc, popup, target } = focusFixture();
        registration.unregister = registerPickerFallbackFocus(() => target);
        const original = fakeElement({ isConnected: false });
        restorePickerFocus(original, popup);
        doc.activeElement = doc.body;
        await Promise.resolve();
        expect(doc.activeElement).toBe(target);
    });

    it('restores a body-originated picker through its popup document', async () => {
        const { doc, popup, target } = focusFixture();
        registration.unregister = registerPickerFallbackFocus(() => target);
        restorePickerFocus(null, popup);
        await Promise.resolve();
        expect(doc.activeElement).toBe(target);
    });
});
