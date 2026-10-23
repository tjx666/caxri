import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { ThemeTokens } from '@caxri/protocol';
import { defaultAppSettings } from '@caxri/protocol';
import { parseEditorModelPath } from '@desktop-shared/editor-state';
import type { OnMount } from '@monaco-editor/react';
import Editor from '@monaco-editor/react';

import { useEditorOptions } from '@/hooks/use-editor-options';
import { languageEditorOptions } from '@/lib/editor-options';

import { applyEditorTheme } from '../../lib/editor-theme';
import { registerTextSelectionSource } from '../../lib/focused-text-selection';
import { monaco } from '../../lib/monaco';
import { useWorkbenchStore } from '../../stores/workbench';
import { publishSourceScroll } from '../preview/preview-scroll-sync';
import { foldEditorOnOpen } from './editor-auto-fold';
import { resolveEditorLanguage, resolveRegisteredEditorLanguage } from './editor-language';
import { synchronizeControlledEditorModel } from './editor-model-sync';
import { markEditorBeforeMount, markEditorMounted } from './editor-performance';
import { registerEditorRevealTarget } from './editor-reveal';
import { EditorSelectionToolbar } from './editor-selection-toolbar';
import { editorSelectionEndLine, useEditorStatusStore } from './editor-status';
import { rememberEditorViewState, restoreEditorViewState } from './editor-view-state';

export interface CodeEditorProperties {
    /**
     * Distinguishes independent Monaco instances that share one document model across split panes.
     */
    editorInstanceId?: string;
    path: string;
    statusKey?: string;
    value: string;
    theme: ThemeTokens;
    readOnly?: boolean;
    onChange: (content: string | undefined) => void;
    /**
     * Called when the editor widget loses focus, including when the whole window does.
     */
    onBlur?: () => void;
}

type MonacoCodeEditor = Parameters<OnMount>[0];

function publishEditorStatus(editor: MonacoCodeEditor, statusKey: string | undefined): void {
    if (!statusKey) return;
    const model = editor.getModel();
    const selection = editor.getSelection();
    if (!model || !selection) return;
    const start = selection.getStartPosition();
    const end = selection.getEndPosition();
    const startOffset = model.getOffsetAt(start);
    const endOffset = model.getOffsetAt(end);
    useEditorStatusStore.getState().setStatus(statusKey, {
        line: selection.positionLineNumber,
        column: selection.positionColumn,
        selectionStartLine: start.lineNumber,
        selectionEndLine: editorSelectionEndLine(start, end),
        selectedCharacters: Math.max(0, endOffset - startOffset),
        languageId: model.getLanguageId(),
    });
}

/**
 * Reports the topmost visible line so an open preview of the same document can follow along. The document path is read
 * back from the model URI rather than threaded through props, keeping this a scroll-time concern only.
 */
function publishScrollPosition(editor: MonacoCodeEditor): void {
    const model = editor.getModel();
    if (!model) return;
    const source = parseEditorModelPath(model.uri);
    if (!source) return;
    const visible = editor.getVisibleRanges().at(0);
    if (!visible) return;
    // markdown-it reports zero-based source lines; Monaco counts from one.
    publishSourceScroll(source.path, visible.startLineNumber - 1);
}

export function CodeEditor({
    editorInstanceId,
    path,
    statusKey,
    value,
    theme,
    readOnly,
    onChange,
    onBlur,
}: CodeEditorProperties) {
    const editorReference = useRef<Parameters<OnMount>[0] | null>(null);
    /**
     * The mounted editor as state, for the selection toolbar, which subscribes to it; `editorReference` serves the
     * imperative paths that must not re-render.
     */
    const [mountedEditor, setMountedEditor] = useState<MonacoCodeEditor>();
    const registrationReference = useRef<(() => void) | undefined>(undefined);
    const cursorSubscriptionReference = useRef<{ dispose(): void } | undefined>(undefined);
    const scrollSubscriptionReference = useRef<{ dispose(): void } | undefined>(undefined);
    const blurSubscriptionReference = useRef<{ dispose(): void } | undefined>(undefined);
    /**
     * The latest callback, read when Monaco reports the blur, so the subscription made once in `onMount` never calls a
     * stale closure for a previous document.
     */
    const onBlurReference = useRef(onBlur);
    const programmaticChangeReference = useRef(false);
    const statusKeyReference = useRef(statusKey);
    const language = resolveEditorLanguage(path);
    const editorOptions = useEditorOptions();
    const foldOnOpenLineThreshold = useWorkbenchStore(
        (state) =>
            state.bootstrap?.settings['editor.foldOnOpenLineThreshold'] ??
            defaultAppSettings['editor.foldOnOpenLineThreshold'],
    );
    /**
     * Held in a ref rather than read from the effect's dependencies: folding is a decision about the moment a document
     * opens, and depending on the live value would collapse every editor that is already open the instant the setting
     * changed, under the hands of whoever was reading one.
     */
    const foldOnOpenThresholdReference = useRef(foldOnOpenLineThreshold);
    const handleChange = useCallback(
        (content: string | undefined) => {
            if (!programmaticChangeReference.current) onChange(content);
        },
        [onChange],
    );
    useEffect(() => {
        foldOnOpenThresholdReference.current = foldOnOpenLineThreshold;
    }, [foldOnOpenLineThreshold]);
    useEffect(() => {
        onBlurReference.current = onBlur;
    }, [onBlur]);
    useEffect(() => applyEditorTheme(theme), [theme]);
    /**
     * Scroll position and cursor outlive the widget that showed them. The two halves run in different effect phases on
     * purpose:
     *
     * - The layout cleanup records the outgoing model while Monaco is still alive: React runs it before
     *   `@monaco-editor/react`'s passive cleanup disposes the editor on unmount (a Session switch remounts the whole
     *   pane tree), and before its passive `path` effect swaps in another model;
     * - The passive body restores afterwards, once that swap has happened. It runs before the reveal registration below
     *   so an explicit navigation (a search hit, a breadcrumb jump) still wins over the remembered position, and it
     *   cannot cover the first mount, where the wrapper creates the editor asynchronously and reports it through
     *   `onMount` instead.
     */
    useLayoutEffect(
        () => () => {
            const editor = editorReference.current;
            if (editor) rememberEditorViewState(editor, editorInstanceId);
        },
        [editorInstanceId, path],
    );
    useEffect(() => {
        const editor = editorReference.current;
        if (editor) restoreEditorViewState(editor, editorInstanceId);
    }, [editorInstanceId, path]);
    useEffect(() => {
        const editor = editorReference.current;
        if (editor)
            synchronizeControlledEditorModel(
                editor,
                monaco.Uri.parse(path).toString(),
                value,
                programmaticChangeReference,
            );
    }, [path, value]);
    useEffect(() => {
        const editor = editorReference.current;
        if (!editor) return;
        registrationReference.current?.();
        const unregister = registerEditorRevealTarget(path, editor, editorInstanceId);
        registrationReference.current = unregister;
        return () => {
            unregister();
            if (registrationReference.current === unregister)
                registrationReference.current = undefined;
        };
    }, [editorInstanceId, path]);
    /**
     * Declared after the two effects above on purpose: the remembered position is restored and any queued reveal has
     * been applied by the time this runs, so both are visible to the decision in `foldEditorOnOpen`. The first mount
     * cannot go through here (the wrapper creates the editor asynchronously) and is handled in `onMount` instead, in
     * the same order.
     */
    useEffect(() => {
        const editor = editorReference.current;
        if (editor)
            foldEditorOnOpen(editor, editorInstanceId, foldOnOpenThresholdReference.current);
    }, [editorInstanceId, path]);
    useEffect(() => {
        statusKeyReference.current = statusKey;
        const frame = requestAnimationFrame(() => {
            if (editorReference.current) publishEditorStatus(editorReference.current, statusKey);
        });
        return () => {
            cancelAnimationFrame(frame);
            if (statusKey) useEditorStatusStore.getState().clearStatus(statusKey);
        };
    }, [path, statusKey]);
    useEffect(
        () => () => {
            cursorSubscriptionReference.current?.dispose();
            scrollSubscriptionReference.current?.dispose();
            blurSubscriptionReference.current?.dispose();
        },
        [],
    );
    return (
        <>
            <Editor
                path={path}
                language={language}
                saveViewState={false}
                value={value}
                theme="caxri-active"
                beforeMount={() => {
                    markEditorBeforeMount();
                    applyEditorTheme(theme);
                }}
                onMount={(editor: Parameters<OnMount>[0]) => {
                    editorReference.current = editor;
                    setMountedEditor(editor);
                    cursorSubscriptionReference.current?.dispose();
                    cursorSubscriptionReference.current = editor.onDidChangeCursorSelection(() =>
                        publishEditorStatus(editor, statusKeyReference.current),
                    );
                    scrollSubscriptionReference.current?.dispose();
                    scrollSubscriptionReference.current = editor.onDidScrollChange(() =>
                        publishScrollPosition(editor),
                    );
                    blurSubscriptionReference.current?.dispose();
                    blurSubscriptionReference.current = editor.onDidBlurEditorWidget(() =>
                        onBlurReference.current?.(),
                    );
                    restoreEditorViewState(editor, editorInstanceId);
                    registrationReference.current?.();
                    registrationReference.current = registerEditorRevealTarget(
                        path,
                        editor,
                        editorInstanceId,
                    );
                    const unregisterSelection = registerTextSelectionSource(
                        editor.getContainerDomNode(),
                        () => {
                            const selection = editor.getSelection();
                            const model = editor.getModel();
                            return selection && model ? model.getValueInRange(selection) : '';
                        },
                    );
                    editor.onDidDispose(unregisterSelection);
                    foldEditorOnOpen(
                        editor,
                        editorInstanceId,
                        foldOnOpenThresholdReference.current,
                    );
                    publishEditorStatus(editor, statusKeyReference.current);
                    markEditorMounted();
                }}
                onChange={handleChange}
                options={{
                    // `editor.wordWrap` belongs to the file editor, so this surface takes it from the base options rather
                    // than forcing `off` the way the diff and transcript surfaces do for their own layout reasons.
                    ...editorOptions,
                    // `language` names only Caxri's own registrations; Monaco infers the rest (Markdown included) from the path.
                    ...languageEditorOptions(
                        resolveRegisteredEditorLanguage(path, monaco.languages.getLanguages()),
                    ),
                    readOnly: readOnly === true,
                    domReadOnly: readOnly === true,
                    find: { addExtraSpaceOnTop: false },
                }}
            />
            <EditorSelectionToolbar editor={mountedEditor} />
        </>
    );
}
