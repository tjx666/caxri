import type { DragEvent, KeyboardEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { SessionRecord } from '@caxri/protocol';

import { didReorderSession } from '../../session/session-actions';
import type { SessionDropTarget } from '../session-order';
import { frozenSessionOrder, SESSION_DRAG_TYPE, sessionDropTarget } from '../session-order';

export function useSessionOrder(sessions: SessionRecord[]) {
    const [draggedId, setDraggedId] = useState<string>();
    const [frozenIds, setFrozenIds] = useState<string[]>();
    const [dropTarget, setDropTarget] = useState<SessionDropTarget>();
    const [announcement, setAnnouncement] = useState('');
    const pending = useRef(false);

    const clear = useCallback((): void => {
        setDraggedId(undefined);
        setFrozenIds(undefined);
        setDropTarget(undefined);
    }, []);
    /**
     * A removed source cannot deliver React's delegated dragend; never leave the sidebar frozen after its removal.
     */
    useEffect(() => {
        if (draggedId && !pending.current && sessions.every((session) => session.id !== draggedId))
            clear();
    }, [clear, draggedId, sessions]);

    useEffect(() => {
        const end = (): void => {
            if (!pending.current) clear();
        };
        addEventListener('dragend', end);
        return () => removeEventListener('dragend', end);
    }, [clear]);
    const persist = async (sessionId: string, target: SessionDropTarget): Promise<void> => {
        pending.current = true;
        try {
            if (await didReorderSession(sessionId, target.anchorSessionId, target.placement))
                setAnnouncement(
                    `Moved ${sessions.find((session) => session.id === sessionId)?.displayTitle ?? 'Session'} ${target.placement} ${sessions.find((session) => session.id === target.anchorSessionId)?.displayTitle ?? 'Session'}`,
                );
        } finally {
            pending.current = false;
            clear();
        }
    };
    const targetAt = (
        event: DragEvent<HTMLElement>,
        anchorSessionId: string,
    ): SessionDropTarget | undefined => {
        if (!draggedId || pending.current || !event.dataTransfer.types.includes(SESSION_DRAG_TYPE))
            return;
        const bounds = event.currentTarget.getBoundingClientRect();
        return sessionDropTarget(
            sessions,
            draggedId,
            anchorSessionId,
            event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after',
        );
    };

    return {
        announcement,
        draggedId,
        dropTarget,
        sessions: frozenSessionOrder(sessions, frozenIds),
        startDrag(event: DragEvent<HTMLElement>, sessionId: string) {
            if (pending.current) {
                event.preventDefault();
                return;
            }
            event.stopPropagation();
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData(SESSION_DRAG_TYPE, sessionId);
            setFrozenIds(sessions.map((session) => session.id));
            setDraggedId(sessionId);
            setAnnouncement('');
        },
        endDrag() {
            if (!pending.current) clear();
        },
        dragOver(event: DragEvent<HTMLElement>, sessionId: string) {
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
        leaveList() {
            setDropTarget(undefined);
        },
        keyDown(
            event: KeyboardEvent<HTMLElement>,
            session: SessionRecord,
            visibleSessions: readonly SessionRecord[],
        ) {
            if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
            event.preventDefault();
            event.stopPropagation();
            if (draggedId || pending.current) return;
            // Hidden rows are not keyboard drop targets: moving into the collapsed tail would unmount the focused row.
            const rows = visibleSessions.filter((row) => row.projectId === session.projectId);
            const delta = event.key === 'ArrowUp' ? -1 : 1;
            const targetIndex = rows.findIndex((row) => row.id === session.id) + delta;
            const anchor = targetIndex >= 0 ? rows.at(targetIndex) : undefined;
            if (!anchor) return;
            // Keyboard reordering uses the same relative Server command and error reporting as dragging.
            // eslint-disable-next-line no-void -- intentional floating-promise discard
            void persist(session.id, {
                anchorSessionId: anchor.id,
                placement: delta === -1 ? 'before' : 'after',
            });
        },
        drop(event: DragEvent<HTMLElement>, sessionId: string) {
            const target = targetAt(event, sessionId);
            if (!draggedId || !target) return;
            event.preventDefault();
            event.stopPropagation();
            setDropTarget(undefined);
            // The command owns error reporting; finally releases the frozen view even after failure.
            // eslint-disable-next-line no-void -- intentional floating-promise discard
            void persist(draggedId, target);
        },
    };
}

export type SessionOrderController = ReturnType<typeof useSessionOrder>;
