import type { SessionRecord } from '@caxri/protocol';
import { isPinnedSession } from '@caxri/protocol';
import { Archive, Pin, PinOff } from 'lucide-react';

import { Tooltip } from '../../components/ui/tooltip';
import { archiveSession, setSessionPinned } from '../session/session-commands';

const actionButton =
    'grid size-5 cursor-pointer place-items-center rounded border-0 bg-elevated p-0 text-muted hover:text-foreground';

/**
 * The Session row's hover actions. Both buttons are `tabIndex={-1}`: the tree has one roving Tab stop, and the keyboard
 * reaches Archive through `Delete` and the pin through the row's context menu.
 */
export function SessionRowActions({ session }: { session: SessionRecord }) {
    const pinned = isPinnedSession(session);
    return (
        <div className="session-row-actions pointer-events-none absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover/session-row:pointer-events-auto group-hover/session-row:opacity-100">
            <Tooltip content={pinned ? 'Unpin Session' : 'Pin Session'}>
                <button
                    type="button"
                    className={`${actionButton} aria-pressed:text-accent`}
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
                    className={actionButton}
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
