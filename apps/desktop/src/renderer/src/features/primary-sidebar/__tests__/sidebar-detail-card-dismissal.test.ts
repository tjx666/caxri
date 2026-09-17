import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDialogStore } from '../../../stores/dialogs';
import { sidebarDetailCardDismissal } from '../sidebar-detail-card-dismissal';

const fixture = {
    target: new EventTarget(),
    dispose: undefined as (() => void) | undefined,
};

beforeEach(() => {
    fixture.target = new EventTarget();
    vi.stubGlobal('addEventListener', fixture.target.addEventListener.bind(fixture.target));
    vi.stubGlobal('removeEventListener', fixture.target.removeEventListener.bind(fixture.target));
    useDialogStore.getState().unregisterModal('dismissal-test');
});

afterEach(() => {
    fixture.dispose?.();
    fixture.dispose = undefined;
    useDialogStore.getState().unregisterModal('dismissal-test');
    vi.unstubAllGlobals();
});

function press(key: string): Event {
    const event = Object.assign(new Event('keydown', { cancelable: true }), { key });
    fixture.target.dispatchEvent(event);
    return event;
}

describe('sidebarDetailCardDismissal', () => {
    it('dismisses on Escape without intercepting other keys', () => {
        const close = vi.fn();
        fixture.dispose = sidebarDetailCardDismissal(close);
        expect(press('Enter').defaultPrevented).toBe(false);
        expect(close).not.toHaveBeenCalled();
        expect(press('Escape').defaultPrevented).toBe(true);
        expect(close).toHaveBeenCalledOnce();
    });

    it('closes when a modal opens and leaves its Escape untouched', () => {
        const close = vi.fn();
        fixture.dispose = sidebarDetailCardDismissal(close);
        useDialogStore.getState().registerModal('dismissal-test');
        expect(close).toHaveBeenCalledOnce();
        expect(press('Escape').defaultPrevented).toBe(false);
        expect(close).toHaveBeenCalledOnce();
    });

    it('releases both listeners when the card closes', () => {
        const close = vi.fn();
        fixture.dispose = sidebarDetailCardDismissal(close);
        fixture.dispose();
        fixture.dispose = undefined;
        useDialogStore.getState().registerModal('dismissal-test');
        useDialogStore.getState().unregisterModal('dismissal-test');
        expect(press('Escape').defaultPrevented).toBe(false);
        expect(close).not.toHaveBeenCalled();
    });
});
