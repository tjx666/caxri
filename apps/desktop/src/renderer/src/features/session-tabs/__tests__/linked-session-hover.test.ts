import { afterEach, describe, expect, it } from 'vitest';

import {
    clearLinkedHoveredSession,
    setLinkedHoveredSession,
    useLinkedSessionHoverStore,
} from '../linked-session-hover';

afterEach(() => {
    useLinkedSessionHoverStore.setState({ sessionId: undefined });
});

describe('linked Session hover', () => {
    it('tracks the hovered Session and clears it on leave', () => {
        setLinkedHoveredSession('a');
        expect(useLinkedSessionHoverStore.getState().sessionId).toBe('a');
        clearLinkedHoveredSession('a');
        expect(useLinkedSessionHoverStore.getState().sessionId).toBeUndefined();
    });

    it('ignores a late leave from a Session the pointer already left for another', () => {
        setLinkedHoveredSession('a');
        setLinkedHoveredSession('b');
        clearLinkedHoveredSession('a');
        expect(useLinkedSessionHoverStore.getState().sessionId).toBe('b');
    });
});
