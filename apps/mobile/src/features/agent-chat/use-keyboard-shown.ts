import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

/**
 * Whether the software keyboard is up. iOS reports the change as it starts (`keyboardWill*`), so a docked card can
 * collapse alongside the keyboard's own animation; Android only reports it once done (`keyboardDid*`). In the Chat it
 * stands in for "the composer or a docked question's answer is focused" without threading focus through the Session
 * screen.
 */
export const useIsKeyboardShown = (): boolean => {
    const [isShown, setShown] = useState(() => Keyboard.isVisible());
    useEffect(() => {
        const prefix = Platform.OS === 'ios' ? 'keyboardWill' : 'keyboardDid';
        const show = Keyboard.addListener(`${prefix}Show`, () => setShown(true));
        const hide = Keyboard.addListener(`${prefix}Hide`, () => setShown(false));
        return () => {
            show.remove();
            hide.remove();
        };
    }, []);
    return isShown;
};
