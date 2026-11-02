import { afterEach, describe, expect, it } from 'vitest';

import {
    draggedSessionId,
    endSessionDrag,
    SESSION_DRAG_TYPE,
    startSessionDrag,
} from '../session-drag';

function dataTransfer(): DataTransfer {
    const data = new Map<string, string>();
    return {
        effectAllowed: 'none',
        get types() {
            return data.keys().toArray();
        },
        setData: (type: string, value: string) => data.set(type, value),
        getData: (type: string) => data.get(type) ?? '',
    } as unknown as DataTransfer;
}

describe('session drag', () => {
    afterEach(() => endSessionDrag());

    it('lets the sidebar reorder and a Chat cite the dragged Session', () => {
        const transfer = dataTransfer();
        startSessionDrag(transfer, 'session-1');
        expect(transfer.effectAllowed).toBe('copyMove');
        expect(transfer.getData(SESSION_DRAG_TYPE)).toBe('session-1');
        expect(draggedSessionId(transfer)).toBe('session-1');
    });

    it('names no Session for another drag or after the drag ends', () => {
        const transfer = dataTransfer();
        startSessionDrag(transfer, 'session-1');
        expect(draggedSessionId({ types: ['Files'] })).toBeUndefined();
        endSessionDrag();
        expect(draggedSessionId(transfer)).toBeUndefined();
    });
});
