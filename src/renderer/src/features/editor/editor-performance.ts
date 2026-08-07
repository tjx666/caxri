const EDITOR_OPEN_START_MARK = 'caxri.editor.open-start';
const EDITOR_DOCUMENT_READY_MARK = 'caxri.editor.document-ready';
const EDITOR_OPEN_TO_DOCUMENT_MEASURE = 'caxri.editor.open-to-document';
const EDITOR_OPEN_TO_BEFORE_MOUNT_MEASURE = 'caxri.editor.open-to-before-mount';
const EDITOR_OPEN_TO_MOUNT_MEASURE = 'caxri.editor.open-to-mount';

function markFromOpen(mark: string, measure: string): void {
    if (performance.getEntriesByName(EDITOR_OPEN_START_MARK, 'mark').length === 0) return;
    performance.clearMarks(mark);
    performance.clearMeasures(measure);
    performance.mark(mark);
    performance.measure(measure, EDITOR_OPEN_START_MARK, mark);
}

/** Retains only the latest editor-open measurement so repeated navigation cannot grow the timeline. */
export function markEditorOpenStarted(): void {
    performance.clearMarks(EDITOR_OPEN_START_MARK);
    performance.clearMarks(EDITOR_DOCUMENT_READY_MARK);
    performance.clearMeasures(EDITOR_OPEN_TO_DOCUMENT_MEASURE);
    performance.clearMeasures(EDITOR_OPEN_TO_BEFORE_MOUNT_MEASURE);
    performance.clearMeasures(EDITOR_OPEN_TO_MOUNT_MEASURE);
    performance.mark(EDITOR_OPEN_START_MARK);
}

export function markEditorBeforeMount(): void {
    markFromOpen('caxri.editor.before-mount', EDITOR_OPEN_TO_BEFORE_MOUNT_MEASURE);
}

export function markEditorMounted(): void {
    markFromOpen('caxri.editor.mounted', EDITOR_OPEN_TO_MOUNT_MEASURE);
}

export function markEditorDocumentReady(): void {
    performance.mark(EDITOR_DOCUMENT_READY_MARK);
    performance.measure(
        EDITOR_OPEN_TO_DOCUMENT_MEASURE,
        EDITOR_OPEN_START_MARK,
        EDITOR_DOCUMENT_READY_MARK,
    );
}
