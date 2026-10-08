import type { EditorNavigationTarget } from '@caxri/protocol';
import type { OnMount } from '@monaco-editor/react';

type MonacoEditor = Parameters<OnMount>[0];

export interface EditorRevealTarget {
    line: number;
    column: number;
    matchLength: number;
    /**
     * Search results select their match; navigation-only reveals leave a caret at the location.
     */
    select?: boolean;
}

const defaultEditorInstance = Symbol('default-editor-instance');
type EditorInstanceKey = string | typeof defaultEditorInstance;

const editors = new Map<string, Map<EditorInstanceKey, MonacoEditor>>();
type EditorRevealIntent =
    | { kind: 'focus' }
    | { kind: 'match'; target: EditorRevealTarget }
    | { kind: 'navigation'; target: EditorNavigationTarget };

const pending = new Map<string, EditorRevealIntent>();
const pendingByInstance = new Map<string, EditorRevealIntent>();

/**
 * When the most recent intent was queued, or `0` once one has been applied. Every intent kind ends in `editor.focus()`,
 * so between queueing one and the commit that mounts the model, keyboard focus genuinely sits on `document.body`, which
 * is indistinguishable from the loss `useTabFocusRecovery` exists to repair. Without this signal, opening a file from
 * the file picker paints a focus ring on the freshly created tab for as long as Monaco's lazy import takes, and then
 * pulls focus into the editor anyway.
 */
const intentQueueState = { queuedAt: 0 };

/**
 * Bounded rather than a plain flag so a model that never mounts (its tab closed mid-open, a surface that failed to
 * render) cannot switch focus recovery off for the rest of the session. Generous next to Monaco's lazy import, short
 * next to any human reaction.
 */
const QUEUED_INTENT_GRACE_MS = 2_000;

/**
 * Whether an Editor intent is queued for a model that has not mounted yet, and is still recent enough to be believed.
 * Read by `useTabFocusRecovery` to stand down instead of claiming focus that is already spoken for.
 */
export function hasPendingEditorIntent(now: number = Date.now()): boolean {
    return (
        intentQueueState.queuedAt !== 0 && now - intentQueueState.queuedAt < QUEUED_INTENT_GRACE_MS
    );
}

/**
 * Queues the strongest intent rather than the latest one. `applyReveal` and `applyNavigation` both end in
 * `editor.focus()`, so a bare `focus` asks for strictly less than a queued `match` or `navigation`, and one open can
 * legitimately queue both under the same key: `openFileForSession` queues the location first, then focuses the model in
 * the same tick. Overwriting there would open the file and leave the caret on line 1.
 */
function queueIntent(
    target: Map<string, EditorRevealIntent>,
    key: string,
    intent: EditorRevealIntent,
): void {
    if (intent.kind === 'focus' && target.get(key)) return;
    target.set(key, intent);
    intentQueueState.queuedAt = Date.now();
}

function pendingInstanceKey(path: string, instanceId: string): string {
    return JSON.stringify([path, instanceId]);
}

function registeredEditor(path: string, instanceId?: string): MonacoEditor | undefined {
    const registrations = editors.get(path);
    if (!registrations) return undefined;
    if (instanceId) return registrations.get(instanceId);
    let latest: MonacoEditor | undefined;
    for (const editor of registrations.values()) latest = editor;
    return latest;
}

/**
 * `monaco.editor.ScrollType.Immediate`, inlined so this module does not pull Monaco's lazily imported bundle in for one
 * enum. Monaco's reveal methods default to a smooth scroll, and a smooth scroll is abandoned when the editor lays out
 * while it is still animating, which is exactly when these reveals run, on the commit that mounts the model. Once
 * `editor.smoothScrolling` defaulted on, clicking a Terminal `path:line` link for an already-open document left the
 * caret on the right line with the viewport still at the top. Every reveal here is a jump the user asked for by name,
 * so it should land at once regardless of how ordinary scrolling is animated.
 */
const IMMEDIATE_SCROLL = 1;

function applyReveal(editor: MonacoEditor, target: EditorRevealTarget): void {
    const endColumn =
        target.column + (target.select === false ? 0 : Math.max(1, target.matchLength));
    editor.setSelection({
        startLineNumber: target.line,
        startColumn: target.column,
        endLineNumber: target.line,
        endColumn,
    });
    editor.revealLineInCenter(target.line, IMMEDIATE_SCROLL);
    editor.focus();
}

function applyNavigation(editor: MonacoEditor, target: EditorNavigationTarget): void {
    if (target.mode === 'caret') {
        editor.setSelection({
            startLineNumber: target.line,
            startColumn: target.column,
            endLineNumber: target.line,
            endColumn: target.column,
        });
        editor.revealLineInCenter(target.line, IMMEDIATE_SCROLL);
        editor.focus();
        return;
    }
    const model = editor.getModel();
    const lineCount = model?.getLineCount() ?? target.endLine + 1;
    const startLine = Math.min(target.startLine, lineCount);
    const endLine = Math.min(target.endLine, lineCount);
    editor.setSelection({
        startLineNumber: startLine,
        startColumn: 1,
        endLineNumber: endLine,
        endColumn: model?.getLineMaxColumn(endLine) ?? 1,
    });
    editor.revealLineInCenter(startLine, IMMEDIATE_SCROLL);
    editor.focus();
}

function applyIntent(editor: MonacoEditor, intent: EditorRevealIntent): void {
    intentQueueState.queuedAt = 0;
    if (intent.kind === 'focus') editor.focus();
    else if (intent.kind === 'match') applyReveal(editor, intent.target);
    else applyNavigation(editor, intent.target);
}

/**
 * Registers one live Editor occurrence for a model. `instanceId` preserves independent split-pane focus while
 * model-only navigation keeps its established latest-mounted fallback.
 */
export function registerEditorRevealTarget(
    path: string,
    editor: MonacoEditor,
    instanceId?: string,
): () => void {
    const registrations = editors.get(path) ?? new Map<EditorInstanceKey, MonacoEditor>();
    const registrationKey = instanceId ?? defaultEditorInstance;
    registrations.set(registrationKey, editor);
    editors.set(path, registrations);
    const generalIntent = pending.get(path);
    if (generalIntent) {
        pending.delete(path);
        applyIntent(editor, generalIntent);
    }
    const instanceIntent = instanceId
        ? pendingByInstance.get(pendingInstanceKey(path, instanceId))
        : undefined;
    if (instanceId && instanceIntent) {
        pendingByInstance.delete(pendingInstanceKey(path, instanceId));
        applyIntent(editor, instanceIntent);
    }
    return () => {
        const current = editors.get(path);
        if (current?.get(registrationKey) !== editor) return;
        current.delete(registrationKey);
        if (current.size === 0) editors.delete(path);
    };
}

/**
 * The Monaco instance currently rendering `path`, for callers that need to run an editor action against it rather than
 * move its caret. Returns nothing when no editor is mounted for that document; there is no queue here, because an
 * action the user invoked applies to the editor they are looking at or to nothing at all.
 */
export function mountedEditor(path: string, instanceId?: string): MonacoEditor | undefined {
    return registeredEditor(path, instanceId);
}

/**
 * Reveals immediately when the model is mounted, otherwise queues one latest intent for mount.
 */
export function revealEditorMatch(path: string, target: EditorRevealTarget): void {
    const editor = registeredEditor(path);
    if (editor) applyReveal(editor, target);
    else queueIntent(pending, path, { kind: 'match', target });
}

/**
 * Queues a reveal without touching a still-registered editor that the current React commit is replacing.
 */
export function queueEditorNavigation(path: string, target: EditorNavigationTarget): void {
    queueIntent(pending, path, { kind: 'navigation', target });
}

/**
 * Focuses a mounted Editor model or queues focus for the commit that mounts a newly opened model. A supplied instance
 * ID keeps a breadcrumb action in the pane that owns it when another pane renders the same Monaco model.
 */
export function focusEditor(path: string, instanceId?: string): void {
    const editor = registeredEditor(path, instanceId);
    if (editor) editor.focus();
    else if (instanceId)
        queueIntent(pendingByInstance, pendingInstanceKey(path, instanceId), { kind: 'focus' });
    else queueIntent(pending, path, { kind: 'focus' });
}

/**
 * Applies an exact caret or inclusive whole-line selection to an already mounted Editor.
 */
export function revealEditorNavigation(path: string, target: EditorNavigationTarget): void {
    const editor = registeredEditor(path);
    if (editor) applyNavigation(editor, target);
    else queueEditorNavigation(path, target);
}
