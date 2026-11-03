import type { ComponentProps } from 'react';

import { useRender } from '@base-ui/react/use-render';
import type { SessionRecord } from '@caxri/protocol';

import { cn } from '../../lib/utilities';
import { didSelectSession } from '../session/session-commands';
import type { SessionOrderController } from './hooks/use-session-order';
import { canSuggestSessionTitle } from './session-rename-draft';
import { sessionRowKeyShortcuts } from './session-row-key-shortcuts';

interface SessionRowTriggerProperties extends ComponentProps<'div'> {
    session: SessionRecord;
    /**
     * The tree row id. Defaults to the Session id; the Pinned group passes a namespaced one so its copy of a pinned
     * Session and the copy under that Session's own Project stay separately addressable.
     */
    rowId?: string;
    /**
     * True for a Session nested under its host (level 3). It is a fixed child of that host, so it is not a drag source,
     * not a drop target, and has no `Alt+Arrow` reorder: its place follows from the Session that created it.
     */
    nested?: boolean;
    selected: boolean;
    renaming: boolean;
    roving: boolean;
    sessionOrder: SessionOrderController;
    /**
     * The rows this row's list shows, in order, for `Alt+Arrow` reordering.
     */
    visibleSessionIds: readonly string[];
    onBeginRename: () => void;
    /**
     * `Shift+Enter`: opens the editor and asks for a name generated from the Session's Agent conversation.
     */
    onSuggestRename: () => void;
    onFocusChange: (isFocused: boolean) => void;
}

/**
 * The Session row's focusable element, and therefore the row's `treeitem` itself. The tree semantics live here rather
 * than on the layout wrapper around it: `aria-level`, `aria-selected`, and the roving `tabIndex` have to describe the
 * element focus actually lands on, or a screen reader announces the row as a plain button and never reads its level or
 * selection.
 *
 * While the row is renaming it keeps the `treeitem` role but gives up its `tabIndex`: the rename input inside it owns
 * focus for as long as the edit lasts. That is the one composition DESIGN.md's tree rule allows: a `treeitem` may
 * contain a text field, but must never be one.
 *
 * A selected pinned Session reports `aria-selected` on both of its rows, which is one more than a single-select tree is
 * supposed to have. The alternative (leaving the Pinned copy unselected) makes the row a keyboard user is standing on
 * announce itself as not selected, which is a worse lie than announcing one Session's selection twice.
 */
export function SessionRowTrigger({
    children,
    session,
    rowId: explicitRowId,
    nested = false,
    selected,
    renaming,
    roving,
    sessionOrder,
    visibleSessionIds,
    onBeginRename,
    onSuggestRename,
    onFocusChange,
    ref,
    ...properties
}: SessionRowTriggerProperties) {
    /**
     * Resolved here rather than as a destructuring default: React Compiler cannot lower a default that reads another
     * destructured prop, and one such default silently leaves the whole component unoptimized.
     */
    const rowId = explicitRowId ?? session.id;
    const canSuggest = canSuggestSessionTitle(session);
    const canReorder = !nested && !renaming;
    const trigger = (
        <div
            ref={sessionOrder.draggedId === session.id ? sessionOrder.sourceReference : undefined}
            data-nested-session={nested ? '' : undefined}
            data-row-id={rowId}
            data-session-id={session.id}
            draggable={canReorder}
            onDragStart={nested ? undefined : (event) => sessionOrder.startDrag(event, session.id)}
            onDragEnd={nested ? undefined : () => sessionOrder.endDrag()}
            onDragOver={nested ? undefined : (event) => sessionOrder.dragOver(event, session.id)}
            onDrop={nested ? undefined : (event) => sessionOrder.drop(event, session.id)}
            className={cn(
                'session-card flex h-7 w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 text-left text-foreground hover:bg-state-hover',
                // Room for the hover actions, which a renaming row does not show.
                !renaming && 'group-hover/session-row:pr-[var(--session-hover-actions)]',
                'focus-visible:ring-1 focus-visible:ring-foreground focus-visible:outline-none',
                selected && 'active bg-elevated',
                renaming && 'cursor-text',
                sessionOrder.draggedId === session.id && 'opacity-50',
            )}
            role="treeitem"
            aria-level={nested ? 3 : 2}
            aria-selected={selected}
            aria-keyshortcuts={sessionRowKeyShortcuts({ canReorder, canSuggest, renaming })}
            tabIndex={renaming ? undefined : roving ? 0 : -1}
            onFocus={(event) => onFocusChange(event.currentTarget.matches(':focus-visible'))}
            onBlur={() => onFocusChange(false)}
            onClick={(event) => {
                if (renaming) return;
                // Option+Click is the pointer shortcut for Rename with AI, as `Shift+Enter` is the keyboard one.
                if (event.altKey) {
                    if (canSuggest) onSuggestRename();
                    return;
                }
                // Fire-and-forget: selection reports its own failures through a toast.
                if (!selected) void didSelectSession(session.id);
            }}
            onDoubleClick={onBeginRename}
            onKeyDown={(event) => {
                if (canReorder) sessionOrder.keyDown(event, session.id, visibleSessionIds);
                if (event.defaultPrevented) return;
                if (!renaming && event.key === 'Enter' && event.shiftKey) {
                    event.preventDefault();
                    if (canSuggest) onSuggestRename();
                } else if (!renaming && event.key === 'Enter') {
                    event.preventDefault();
                    onBeginRename();
                } else if (!renaming && event.key === ' ') {
                    event.preventDefault();
                    // Fire-and-forget: didSelectSession reports its own failures through a toast.
                    if (!selected) void didSelectSession(session.id);
                }
            }}
        >
            {children}
        </div>
    );
    /**
     * HoverCardTrigger supplies handlers, accessible descriptions, and a ref through its render prop. Preserve and
     * merge them with the row's own interactions instead of dropping them at this component boundary.
     */
    return useRender({ render: trigger, ref, props: properties });
}
