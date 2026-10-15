import { afterEach, describe, expect, it, vi } from 'vitest';

import { setSessionRowHovered, useSessionRowHoverStore } from '../session-row-hover-store';

afterEach(() => useSessionRowHoverStore.setState({ rowId: undefined }));

describe('Session row hover ownership', () => {
    it('notifies consumers only when movement changes the hovered row', () => {
        const listener = vi.fn();
        const unsubscribe = useSessionRowHoverStore.subscribe(listener);
        try {
            setSessionRowHovered('pinned:first', true);
            setSessionRowHovered('pinned:first', true);
            expect(listener).toHaveBeenCalledTimes(1);
            setSessionRowHovered('pinned:next', true);
            setSessionRowHovered('pinned:first', false);
            expect(listener).toHaveBeenCalledTimes(2);
            expect(useSessionRowHoverStore.getState().rowId).toBe('pinned:next');
        } finally {
            unsubscribe();
        }
    });

    it('keeps the new row hovered when the previous row delivers a late leave', () => {
        setSessionRowHovered('project:example', true);
        setSessionRowHovered('pinned:example', true);
        setSessionRowHovered('project:example', false);
        expect(useSessionRowHoverStore.getState().rowId).toBe('pinned:example');
        setSessionRowHovered('pinned:example', false);
        expect(useSessionRowHoverStore.getState().rowId).toBeUndefined();
    });
});
