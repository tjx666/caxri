import { useRef } from 'react';
import type { TextInputInstance } from 'react-native';

/**
 * Owns the hidden Terminal keyboard field so the surface tap, the take-over action, and the control bar toggle all
 * drive the same input.
 */
export const useTerminalKeyboard = () => {
    const input = useRef<TextInputInstance>(null);
    return {
        focus: () => input.current?.focus(),
        input,
        toggle: () => {
            if (input.current?.isFocused()) input.current.blur();
            else input.current?.focus();
        },
    };
};
