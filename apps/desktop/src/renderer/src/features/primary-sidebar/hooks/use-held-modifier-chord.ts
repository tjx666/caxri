import { useEffect, useState } from 'react';

import { heldModifierChord } from '../pinned-shortcut-hints';

/**
 * How long a modifier must be held alone before its hints appear. A chord typed at normal speed (`Cmd+C`) lands its key
 * well inside this window, so ordinary shortcuts never flash the hints.
 */
const HOLD_DELAY_MS = 400;

/**
 * The modifiers held on their own for {@link HOLD_DELAY_MS}, or `''`. Pressing any other key withdraws the hints until
 * every modifier is released, so a chord in progress never shows them; losing window focus clears them, because the
 * release would arrive at another app.
 */
export function useHeldModifierChord(): string {
    const [chord, setChord] = useState('');
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let isChordInProgress = false;
        const reset = (): void => {
            clearTimeout(timer);
            timer = undefined;
            setChord('');
        };
        const track = (event: KeyboardEvent, isModifierKey: boolean): void => {
            const held = heldModifierChord(event);
            if (!held) isChordInProgress = false;
            if (!isModifierKey) isChordInProgress = held !== '';
            reset();
            if (!held || isChordInProgress) return;
            timer = setTimeout(() => setChord(held), HOLD_DELAY_MS);
        };
        const isModifier = (key: string): boolean =>
            ['Meta', 'Control', 'Alt', 'Shift'].includes(key);
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.repeat) return;
            track(event, isModifier(event.key));
        };
        const onKeyUp = (event: KeyboardEvent): void => {
            if (isModifier(event.key)) track(event, true);
        };
        const onBlur = (): void => {
            isChordInProgress = false;
            reset();
        };
        // Capture phase: a focused xterm or editor stops propagation of the keys it consumes.
        addEventListener('keydown', onKeyDown, { capture: true });
        addEventListener('keyup', onKeyUp, { capture: true });
        addEventListener('blur', onBlur);
        return () => {
            clearTimeout(timer);
            removeEventListener('keydown', onKeyDown, true);
            removeEventListener('keyup', onKeyUp, true);
            removeEventListener('blur', onBlur);
        };
    }, []);
    return chord;
}
