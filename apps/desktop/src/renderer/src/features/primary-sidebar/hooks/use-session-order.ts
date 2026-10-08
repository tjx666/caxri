import type { DragEvent, KeyboardEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { SessionRecord } from '@caxri/protocol';

import { useLatestReference } from '../../../hooks/use-latest-reference';
import { didReorderSession } from '../../session/session-commands';
import type { SessionDropTarget } from '../session-order';
import {
    frozenSessionOrder,
    keyboardReorderTarget,
    SESSION_DRAG_TYPE,
    sessionDropTarget,
    sessionMoveAnnouncement,
} from '../session-order';

/**
 * `groupOf`'s default. Hoisted out of the destructuring default below rather than written inline, for two reasons: an
 * inline arrow there would be recreated on every call, which would defeat every `useCallback` below that closes over it
 * once memoized; and React Compiler cannot yet lower an arrow function written as a destructuring default at all
 * (`BuildHIR::node.lowerReorderableExpression`), which silently disqualifies the whole hook from its own
 * auto-memoization (issue #1108).
 */
function sessionProjectId(session: SessionRecord): string {
    return session.projectId;
}

interface SessionOrderOptions {
    /**
     * Resolves a hovered row into a drop target, or `undefined` to refuse the drop. Defaults to the Project groups'
     * rule, which refuses a drop across two Projects.
     */
    dropTargetAt?: (
        sessions: readonly SessionRecord[],
        draggedId: string | undefined,
        anchorSessionId: string,
        placement: 'before' | 'after',
    ) => SessionDropTarget | undefined;
    /**
     * Which list a Session belongs to, for `Alt+Arrow` keyboard reordering. Defaults to its Project; the Pinned group
     * answers with one constant because it is a single list spanning every Project.
     */
    groupOf?: (session: SessionRecord) => string;
    /**
     * Sends the move to the Server and resolves once the refreshed state has landed. Defaults to `session.reorder`.
     */
    reorder?: (
        sessionId: string,
        anchorSessionId: string,
        placement: 'before' | 'after',
    ) => Promise<boolean>;
}

/**
 * Drag-and-keyboard reordering for one list of Session rows. The Pinned group and each Project group are separate lists
 * over the same Session records, so this takes the three rules that differ: which drops are legal, which rows count as
 * siblings, and which Server method records the move, and keeps everything else (the frozen order during a drag, the
 * dragend cleanup, the announcement) in one place.
 *
 * Returns the controller every row receives apart from the list it orders. The handlers read the records through a
 * latest-value ref instead of closing over them, because the records change on every Session switch: the Server stamps
 * the opened Session's `lastOpenedAt`, which replaces the list. A controller rebuilt from that list would reach every
 * row as a new prop and render all of them again, when only the two rows whose selection moved have anything new to
 * show (issue #1356).
 */
export function useSessionOrder(sessions: SessionRecord[], options: SessionOrderOptions = {}) {
    const {
        dropTargetAt = sessionDropTarget,
        groupOf = sessionProjectId,
        reorder = didReorderSession,
    } = options;
    const [draggedId, setDraggedId] = useState<string>();
    const [frozenIds, setFrozenIds] = useState<string[]>();
    const [dropTarget, setDropTarget] = useState<SessionDropTarget>();
    const [announcement, setAnnouncement] = useState('');
    const pending = useRef(false);
    const latestSessions = useLatestReference(sessions);

    const clear = useCallback((): void => {
        setDraggedId(undefined);
        setFrozenIds(undefined);
        setDropTarget(undefined);
    }, []);
    /**
     * A removed source cannot deliver React's delegated dragend. Its ref cleanup owns cancellation at the DOM boundary.
     */
    const sourceReference = useCallback(
        (element: HTMLDivElement | null): void => {
            if (!element && draggedId && !pending.current) clear();
        },
        [clear, draggedId],
    );

    useEffect(() => {
        const end = (): void => {
            if (!pending.current) clear();
        };
        addEventListener('dragend', end);
        return () => removeEventListener('dragend', end);
    }, [clear]);
    const persist = useCallback(
        async (sessionId: string, target: SessionDropTarget): Promise<void> => {
            const moveAnnouncement = sessionMoveAnnouncement(
                latestSessions.current,
                sessionId,
                target,
            );
            pending.current = true;
            try {
                if (await reorder(sessionId, target.anchorSessionId, target.placement))
                    setAnnouncement(moveAnnouncement);
            } finally {
                pending.current = false;
                clear();
            }
        },
        [clear, latestSessions, reorder],
    );
    const targetAt = useCallback(
        (event: DragEvent<HTMLElement>, anchorSessionId: string): SessionDropTarget | undefined => {
            if (
                !draggedId ||
                pending.current ||
                !event.dataTransfer.types.includes(SESSION_DRAG_TYPE)
            )
                return;
            const bounds = event.currentTarget.getBoundingClientRect();
            return dropTargetAt(
                latestSessions.current,
                draggedId,
                anchorSessionId,
                event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after',
            );
        },
        [draggedId, dropTargetAt, latestSessions],
    );

    const startDrag = useCallback(
        (event: DragEvent<HTMLElement>, sessionId: string) => {
            if (pending.current) {
                event.preventDefault();
                return;
            }
            event.stopPropagation();
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData(SESSION_DRAG_TYPE, sessionId);
            setFrozenIds(latestSessions.current.map((session) => session.id));
            setDraggedId(sessionId);
            setAnnouncement('');
        },
        [latestSessions],
    );
    const endDrag = useCallback(() => {
        if (!pending.current) clear();
    }, [clear]);
    const dragOver = useCallback(
        (event: DragEvent<HTMLElement>, sessionId: string) => {
            const target = targetAt(event, sessionId);
            if (!target) {
                setDropTarget(undefined);
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = 'move';
            setDropTarget((current) =>
                current?.anchorSessionId === target.anchorSessionId &&
                current.placement === target.placement
                    ? current
                    : target,
            );
        },
        [targetAt],
    );
    const leaveList = useCallback(() => {
        setDropTarget(undefined);
    }, []);
    const keyDown = useCallback(
        (
            event: KeyboardEvent<HTMLElement>,
            sessionId: string,
            /**
             * The rows the focused row's list shows, in order. Ids rather than records, so the list a row holds keeps
             * its identity through a refresh that only replaced records.
             */
            visibleSessionIds: readonly string[],
        ) => {
            if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
            event.preventDefault();
            event.stopPropagation();
            if (draggedId || pending.current) return;
            const target = keyboardReorderTarget({
                direction: event.key === 'ArrowUp' ? -1 : 1,
                groupOf,
                sessionId,
                sessions: latestSessions.current,
                visibleSessionIds,
            });
            if (!target) return;
            // Keyboard reordering uses the same relative Server command and error reporting as dragging.
            // eslint-disable-next-line no-void -- intentional floating-promise discard
            void persist(sessionId, target);
        },
        [draggedId, groupOf, latestSessions, persist],
    );
    const drop = useCallback(
        (event: DragEvent<HTMLElement>, sessionId: string) => {
            const target = targetAt(event, sessionId);
            if (!draggedId || !target) return;
            event.preventDefault();
            event.stopPropagation();
            setDropTarget(undefined);
            // The command owns error reporting; finally releases the frozen view even after failure.
            // eslint-disable-next-line no-void -- intentional floating-promise discard
            void persist(draggedId, target);
        },
        [targetAt, draggedId, persist],
    );

    /**
     * Memoized so a re-render that leaves this list's own drag state untouched returns the exact same controller
     * object. Every Session row receives it as a prop, so a fresh object would render every row again (issues #1108 and
     * #1356). None of its inputs depend on the records themselves, which is what keeps it stable through a Session
     * switch; the ordered list travels beside it instead of inside it. React Compiler cannot cover this hook on its
     * own: the `try`/`finally` in `persist` above has no `catch` clause, which is also not yet lowered
     * (`BuildHIR::lowerStatement`), so this hook falls back to manual memoization throughout.
     */
    const controller = useMemo(
        () => ({
            announcement,
            draggedId,
            dropTarget,
            sourceReference,
            startDrag,
            endDrag,
            dragOver,
            leaveList,
            keyDown,
            drop,
        }),
        [
            announcement,
            draggedId,
            dropTarget,
            sourceReference,
            startDrag,
            endDrag,
            dragOver,
            leaveList,
            keyDown,
            drop,
        ],
    );
    /**
     * The list in display order, frozen while a drag is in flight so the rows under the pointer hold still.
     */
    const orderedSessions = useMemo(
        () => frozenSessionOrder(sessions, frozenIds),
        [sessions, frozenIds],
    );
    return { controller, sessions: orderedSessions };
}

export type SessionOrderController = ReturnType<typeof useSessionOrder>['controller'];
