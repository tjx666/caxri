/**
 * Custom MIME type carrying a dragged Session row's id: the sidebar reorders by it, and a Chat cites the Session.
 */
export const SESSION_DRAG_TYPE = 'application/x-caxri-session';

/**
 * The Session this window is dragging. Chromium hides `getData` until `drop`, so a Chat could not otherwise tell during
 * `dragover` whether the row is its own Session, which it refuses to cite. A Session row only drags inside its own
 * window, so one module value is enough.
 */
const current: { sessionId?: string } = {};

/**
 * Starts dragging a Session row. `copyMove` lets the sidebar reorder it (`move`) and a Chat cite it (`copy`).
 */
export function startSessionDrag(dataTransfer: DataTransfer, sessionId: string): void {
    dataTransfer.effectAllowed = 'copyMove';
    dataTransfer.setData(SESSION_DRAG_TYPE, sessionId);
    current.sessionId = sessionId;
}

export function endSessionDrag(): void {
    current.sessionId = undefined;
}

/**
 * The id of the Session row being dragged, or `undefined` when the drag carries none. Readable during `dragover`.
 */
export function draggedSessionId(dataTransfer: Pick<DataTransfer, 'types'>): string | undefined {
    return dataTransfer.types.includes(SESSION_DRAG_TYPE) ? current.sessionId : undefined;
}
