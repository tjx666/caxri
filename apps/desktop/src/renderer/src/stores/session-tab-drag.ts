import { createStore } from '../lib/store';

interface SessionTabDragState {
    /**
     * Whether one of this window's Open Session tabs is being dragged right now.
     */
    isDragging: boolean;
    setDragging(isDragging: boolean): void;
}

/**
 * Whether an Open Session tab drag is in progress. The strip reads it to stay mounted for the whole gesture: if the
 * strip's membership dropped below two mid-drag (a Session archived elsewhere), the strip would vanish, taking the drag
 * source and its `dragend` with it, and the title bar would jump under the pointer. Nothing but the strip's drag hook
 * writes it.
 */
export const useSessionTabDragStore = createStore<SessionTabDragState>(
    'session-tab-drag',
    (set) => ({
        isDragging: false,
        setDragging: (isDragging) => set({ isDragging }),
    }),
);
