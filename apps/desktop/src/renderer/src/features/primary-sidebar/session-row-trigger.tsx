import type { ComponentProps } from 'react';

import { useRender } from '@base-ui/react/use-render';
import type { SessionRecord } from '@caxri/protocol';

import { cn } from '../../lib/utilities';
import { didSelectSession, openSession } from '../session/session-commands';
import type { SessionOrderController } from './hooks/use-session-order';

interface SessionRowTriggerProperties extends ComponentProps<'div'> {
    session: SessionRecord;
    selected: boolean;
    renaming: boolean;
    roving: boolean;
    sessionOrder: SessionOrderController;
    visibleSessions: readonly SessionRecord[];
    onBeginRename: () => void;
    onFocusChange: (isFocused: boolean) => void;
}

export function SessionRowTrigger({
    children,
    session,
    selected,
    renaming,
    roving,
    sessionOrder,
    visibleSessions,
    onBeginRename,
    onFocusChange,
    ref,
    ...properties
}: SessionRowTriggerProperties) {
    const trigger = (
        <div
            ref={sessionOrder.draggedId === session.id ? sessionOrder.sourceReference : undefined}
            data-row-id={session.id}
            data-session-id={session.id}
            draggable={!renaming}
            onDragStart={(event) => sessionOrder.startDrag(event, session.id)}
            onDragEnd={() => sessionOrder.endDrag()}
            onDragOver={(event) => sessionOrder.dragOver(event, session.id)}
            onDrop={(event) => sessionOrder.drop(event, session.id)}
            className={cn(
                'session-card flex h-7 w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 text-left text-foreground hover:bg-[color-mix(in_srgb,var(--elevated)_60%,transparent)]',
                'focus-visible:ring-1 focus-visible:ring-foreground focus-visible:outline-none',
                selected && 'active bg-elevated',
                renaming && 'cursor-text',
                sessionOrder.draggedId === session.id && 'opacity-50',
            )}
            role={renaming ? undefined : 'button'}
            aria-keyshortcuts={renaming ? undefined : 'Alt+ArrowUp Alt+ArrowDown'}
            tabIndex={renaming ? undefined : roving ? 0 : -1}
            onFocus={(event) => onFocusChange(event.currentTarget.matches(':focus-visible'))}
            onBlur={() => onFocusChange(false)}
            onClick={() => {
                // Fire-and-forget: didSelectSession reports its own failures through a toast.
                // eslint-disable-next-line no-void -- intentional floating-promise discard
                if (!renaming && !selected) void didSelectSession(session.id);
            }}
            // Opens the Session, the way double-click opens an item in Finder, in the VS Code explorer, and on this
            // app's own tab strip. It used to start a rename, which is the one meaning the gesture has nowhere else.
            onDoubleClick={() => {
                if (!renaming) openSession(session.id);
            }}
            onKeyDown={(event) => {
                if (!renaming) sessionOrder.keyDown(event, session, visibleSessions);
                if (event.defaultPrevented) return;
                if (!renaming && event.key === 'Enter') {
                    event.preventDefault();
                    onBeginRename();
                } else if (!renaming && event.key === ' ') {
                    event.preventDefault();
                    // Fire-and-forget: didSelectSession reports its own failures through a toast.
                    // eslint-disable-next-line no-void -- intentional floating-promise discard
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
