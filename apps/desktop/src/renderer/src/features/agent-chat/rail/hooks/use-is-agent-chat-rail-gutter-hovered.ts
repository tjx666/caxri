import { useEffect, useState } from 'react';

import { isAgentChatRailGutter } from '../agent-chat-rail-marks';

/**
 * Whether the pointer is in the left gutter of the conversation area that holds `rail`, so the rail can stay out of
 * sight while the reader reads and appear when they reach for it. Listens on the area itself, so the transcript keeps
 * scrolling under the gutter; a move that does not cross the gutter's edge sets the same value and renders nothing.
 */
export function useIsAgentChatRailGutterHovered(rail: HTMLElement | null): boolean {
    const [isInGutter, setInGutter] = useState(false);
    useEffect(() => {
        const area = rail?.parentElement;
        if (!area) return;
        const onMove = (event: PointerEvent): void =>
            setInGutter(isAgentChatRailGutter(event.clientX, area.getBoundingClientRect().left));
        const onLeave = (): void => setInGutter(false);
        area.addEventListener('pointermove', onMove);
        area.addEventListener('pointerleave', onLeave);
        return () => {
            area.removeEventListener('pointermove', onMove);
            area.removeEventListener('pointerleave', onLeave);
        };
    }, [rail]);
    return isInGutter;
}
