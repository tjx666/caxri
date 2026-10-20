import { useEffect } from 'react';

import { commitMruSession } from '../session-commands';
import { useSessionMruSwitcherStore } from '../session-mru-switcher-state';

const HELD_MODIFIER_KEYS: ReadonlySet<string> = new Set(['Alt', 'Control', 'Meta', 'Shift']);

function isHeldModifier(key: string): key is 'Alt' | 'Control' | 'Meta' | 'Shift' {
    return HELD_MODIFIER_KEYS.has(key);
}

function commitSessionMruSwitcher(): void {
    commitMruSession();
}

/**
 * Owns the hold/repeat/release keyboard lifecycle outside the command dispatcher. The first keystroke travels through
 * the configurable command binding; repeated trigger presses, Escape, modifier release, and window-focus loss need
 * stateful handling while the switcher is open. Listeners stay mounted so even an immediate modifier release commits.
 */
export function useSessionMruSwitcherLifecycle(): void {
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            const state = useSessionMruSwitcherStore.getState();
            if (!state.isOpen) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                state.cancel();
                return;
            }
            if (event.code === state.triggerCode) {
                event.preventDefault();
                event.stopImmediatePropagation();
                state.cycle(event.shiftKey ? -1 : 1);
            }
        };
        const onKeyUp = (event: KeyboardEvent): void => {
            const state = useSessionMruSwitcherStore.getState();
            if (!state.isOpen) return;
            if (isHeldModifier(event.key) && state.heldModifiers.includes(event.key))
                commitSessionMruSwitcher();
        };
        const onBlur = (): void => {
            if (useSessionMruSwitcherStore.getState().isOpen) commitSessionMruSwitcher();
        };
        addEventListener('keydown', onKeyDown, { capture: true });
        addEventListener('keyup', onKeyUp, { capture: true });
        addEventListener('blur', onBlur);
        return () => {
            removeEventListener('keydown', onKeyDown, { capture: true });
            removeEventListener('keyup', onKeyUp, { capture: true });
            removeEventListener('blur', onBlur);
        };
    }, []);
}
