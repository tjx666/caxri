import type { SessionOpenPlace } from '../../stores/open-sessions';

/**
 * The quiet neutral edge bar on a sidebar row whose Session is a tab of this window. Never the accent: the accent says
 * where input goes, and this only says "also in your strip". Positioned against the row wrapper.
 */
export function SessionOpenEdge({ place }: { place: SessionOpenPlace | undefined }) {
    if (place !== 'here') return null;
    return (
        <span
            aria-hidden="true"
            className="session-open-marker pointer-events-none absolute top-2 bottom-2 left-0 w-0.5 rounded-full bg-muted"
        />
    );
}
