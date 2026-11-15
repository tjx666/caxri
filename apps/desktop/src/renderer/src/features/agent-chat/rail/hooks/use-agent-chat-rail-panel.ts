import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * How long the pointer rests on the rail before its list opens, so a pointer crossing the rail on its way to the
 * scrollbar does not flash the list.
 */
const OPEN_DELAY_MS = 100;

/**
 * How long the list stays after the pointer leaves, so the gap between the rail and the list's edge never closes it.
 */
const CLOSE_DELAY_MS = 120;

/**
 * Whether the message rail's list is open: while the pointer rests on the rail or the list, or keyboard focus is in the
 * list. The pointer and the keyboard are tracked apart, so a pointer leaving never closes the list a keyboard user is
 * reading, and the one timer this owns is replaced by every pointer move in or out.
 */
export function useAgentChatRailPanel(): {
    isOpen: boolean;
    pointerEnter: () => void;
    pointerLeave: () => void;
    /**
     * Keyboard focus entered (`true`) or left (`false`) the list.
     */
    setKeyboardOpen: (isOpen: boolean) => void;
    /**
     * A jump or Escape: close at once, whatever opened the list.
     */
    close: () => void;
} {
    const [isHovered, setHovered] = useState(false);
    const [isKeyboardOpen, setKeyboardOpen] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
    useEffect(() => () => clearTimeout(timer.current), []);
    const actions = useMemo(() => {
        const after = (delay: number, isNextHovered: boolean): void => {
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setHovered(isNextHovered), delay);
        };
        return {
            pointerEnter: () => after(OPEN_DELAY_MS, true),
            pointerLeave: () => after(CLOSE_DELAY_MS, false),
            setKeyboardOpen,
            close: () => {
                clearTimeout(timer.current);
                setHovered(false);
                setKeyboardOpen(false);
            },
        };
    }, []);
    return { isOpen: isHovered || isKeyboardOpen, ...actions };
}
