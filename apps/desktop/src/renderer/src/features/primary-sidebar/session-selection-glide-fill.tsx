import type { RefObject } from 'react';
import { useRef } from 'react';

import { useSessionSelectionGlide } from './hooks/use-session-selection-glide';

/**
 * The selection glide's fill inside the Project list (`useSessionSelectionGlide`). Render it first in the list so every
 * row (each `session-row` is positioned) paints above it; it stays hidden except during a glide.
 */
export function SessionSelectionGlideFill({
    list,
    selectedSessionId,
}: {
    list: RefObject<HTMLElement | null>;
    selectedSessionId: string | undefined;
}) {
    const ghost = useRef<HTMLDivElement>(null);
    useSessionSelectionGlide(list, ghost, selectedSessionId);
    return (
        <div
            ref={ghost}
            aria-hidden="true"
            className="session-selection-glide pointer-events-none absolute hidden rounded-md bg-elevated"
        />
    );
}
