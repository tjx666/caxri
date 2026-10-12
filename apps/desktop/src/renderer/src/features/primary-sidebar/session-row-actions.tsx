import type { SessionRecord } from '@caxri/protocol';
import { isPinnedSession } from '@caxri/protocol';
import { Archive, Pin, PinOff } from 'lucide-react';

import { Tooltip } from '../../components/ui/tooltip';
import { archiveSession } from '../session/session-archive-commands';
import { setSessionPinned } from '../session/session-commands';

/**
 * The Session hover-action chip, shared with the Activity row's mark-read button so a Session's pointer actions look
 * the same in either body of the Primary Side Bar.
 */
export const sessionRowActionButton =
    'grid size-5 cursor-pointer place-items-center rounded border-0 bg-elevated p-0 text-muted hover:text-foreground';

/**
 * The Session row's hover actions. Both buttons are `tabIndex={-1}`: the tree has one roving Tab stop, and the keyboard
 * reaches Archive through `Delete` and the pin through the row's context menu.
 *
 * `right-1` plus two `size-5` buttons and `gap-0.5` is 2.875rem. The owning `.session-row` publishes that width as
 * `--session-hover-actions`, and the card reserves it on hover so overflowing titles fade before this cluster instead
 * of painting through the transparent Lucide strokes.
 */
export function SessionRowActions({ session }: { session: SessionRecord }) {
    const pinned = isPinnedSession(session);
    return (
        <div className="session-row-actions pointer-events-none absolute top-1/2 right-1 z-10 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover/session-row:pointer-events-auto group-hover/session-row:opacity-100">
            <Tooltip content={pinned ? 'Unpin Session' : 'Pin Session'}>
                <button
                    type="button"
                    className={`${sessionRowActionButton} aria-pressed:text-accent`}
                    aria-label={`Pin ${session.displayTitle}`}
                    aria-pressed={pinned}
                    tabIndex={-1}
                    onClick={() => setSessionPinned(session.id, !pinned)}
                >
                    {pinned ? <PinOff size={12} /> : <Pin size={12} />}
                </button>
            </Tooltip>
            <Tooltip content="Archive Session">
                <button
                    type="button"
                    className={sessionRowActionButton}
                    aria-label={`Archive ${session.displayTitle}`}
                    aria-keyshortcuts="Delete"
                    tabIndex={-1}
                    onClick={() => archiveSession(session.id)}
                >
                    <Archive size={12} />
                </button>
            </Tooltip>
        </div>
    );
}
