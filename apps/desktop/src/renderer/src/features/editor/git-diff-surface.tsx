import type { ReactElement } from 'react';
import { useEffect, useId, useLayoutEffect, useRef } from 'react';

import type { GitDiffDocument, GitDiffTab } from '@caxri/protocol';
import { gitDiffModelPath } from '@caxri/protocol';
import { disposeAllThenRethrow } from '@caxri/utils';
import type { DiffOnMount, OnMount } from '@monaco-editor/react';
import Editor from '@monaco-editor/react';

import { useEditorOptions } from '@/hooks/use-editor-options';
import { languageEditorOptions } from '@/lib/editor-options';

import { applyEditorTheme } from '../../lib/editor-theme';
import { monaco } from '../../lib/monaco';
import { useTheme } from '../../stores/selectors';
import { resolveRegisteredEditorLanguage } from './editor-language';
import type { DiffEditorActions } from './git-diff-actions';
import { monacoDiffEditorActions, registerDiffEditorActions } from './git-diff-actions';
import { observeGitEditorContentHeight } from './git-diff-model-lifecycle';
import { GitMonacoDiffEditor } from './git-monaco-diff-editor';
import { initialStackedEditorHeight, maxStackedEditorHeight } from './git-multi-diff-viewport';
import { bindGitReviewCommentEditor } from './git-review-comment-binding';
import { refreshGitReviewComments } from './git-review-comment-commands';
import { GitSingleDiffEditor } from './git-single-diff-editor';

/**
 * Callers key the content shape so swapping single/double-sided editors fully releases the previous models.
 */
export function GitDiffSurface({
    contentHeight,
    document,
    editorInstanceId,
    navigationKey,
    onContentHeightChange,
    repositoryId,
    sessionId,
    source,
    sourceKey,
    stacked = false,
}: {
    /**
     * Owned by the multi-diff item (not locally) so the remembered height survives the editor being virtualized out of
     * the near-viewport window: a 360px reset there would yank the outer scroll position every time an item unmounts.
     */
    contentHeight?: number;
    document: GitDiffDocument;
    editorInstanceId?: string;
    navigationKey?: string;
    onContentHeightChange?: (height: number) => void;
    repositoryId: string;
    sessionId: string;
    source: GitDiffTab['source'];
    sourceKey: string;
    /**
     * Multi-file changes mode: the editor sizes itself to its diff content (collapsing unchanged regions, VS Code
     * multi-diff style) instead of filling the parent, so the outer list owns scrolling and the wheel is never captured
     * by an inner editor that already fits.
     */
    stacked?: boolean;
}) {
    const theme = useTheme();
    const editorReference = useRef<DiffEditorActions | null>(null);
    const diffEditorRegistrationReference = useRef<(() => void) | undefined>(undefined);
    const editorOptions = useEditorOptions();
    useEffect(() => {
        if (document.format !== 'contents') return;
        // eslint-disable-next-line no-void -- floating-promise discard: outdated status refetches via `gitReview.changed`
        void refreshGitReviewComments(
            sessionId,
            repositoryId,
            sourceKey,
            document.path,
            'modified',
            document.modified,
        );
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void refreshGitReviewComments(
            sessionId,
            repositoryId,
            sourceKey,
            document.originalPath ?? document.path,
            'original',
            document.original,
        );
    }, [document, sessionId, repositoryId, sourceKey]);
    const contentSizeListeners = useRef<Array<{ dispose(): void }>>([]);
    useEffect(() => {
        if (theme) applyEditorTheme(theme);
    }, [theme]);
    useLayoutEffect(
        () => () => {
            /**
             * Dispose the content-size listeners first so `setModel(null)` below cannot re-enter the height callback (a
             * parent setState) while this component is unmounting.
             */
            const listeners = contentSizeListeners.current;
            contentSizeListeners.current = [];
            try {
                disposeAllThenRethrow(listeners);
            } finally {
                diffEditorRegistrationReference.current?.();
                diffEditorRegistrationReference.current = undefined;
                editorReference.current = null;
            }
        },
        [],
    );
    useEffect(() => {
        const editor = editorReference.current;
        if (!editor || !navigationKey || !editorInstanceId) return;
        diffEditorRegistrationReference.current?.();
        diffEditorRegistrationReference.current = registerDiffEditorActions(
            navigationKey,
            editorInstanceId,
            editor,
        );
        return () => {
            diffEditorRegistrationReference.current?.();
            diffEditorRegistrationReference.current = undefined;
        };
    }, [editorInstanceId, navigationKey]);
    /**
     * Per-instance model paths: the same file can be open as a single-file diff tab and inside a multi-diff list (or in
     * two panes) at once, and Monaco resolves `getOrCreateModel` by path, so a shared path would make one surface's
     * unmount dispose the models the other is still showing.
     */
    const surfaceId = useId();
    if (!theme) return null;
    const modelRepoId = `${source}:${repositoryId}:${surfaceId}`;
    const registrations = monaco.languages.getLanguages();
    const originalLanguage = resolveRegisteredEditorLanguage(
        document.originalPath ?? document.path,
        registrations,
    );
    const modifiedLanguage = resolveRegisteredEditorLanguage(document.path, registrations);
    const withStackedSurface = (editorElement: ReactElement): ReactElement =>
        stacked ? (
            <div
                className="git-multi-diff-surface overflow-hidden"
                style={{
                    height: Math.min(
                        contentHeight ?? initialStackedEditorHeight,
                        maxStackedEditorHeight,
                    ),
                }}
            >
                {editorElement}
            </div>
        ) : (
            editorElement
        );
    if (
        document.format === 'contents' &&
        (document.original === '') !== (document.modified === '')
    ) {
        return withStackedSurface(
            <GitSingleDiffEditor
                document={document}
                editorInstanceId={editorInstanceId}
                modifiedLanguage={modifiedLanguage}
                modelRepoId={modelRepoId}
                navigationKey={navigationKey}
                onContentHeightChange={stacked ? onContentHeightChange : undefined}
                originalLanguage={originalLanguage}
                sessionId={sessionId}
                repositoryId={repositoryId}
                sourceKey={sourceKey}
            />,
        );
    }
    if (document.format === 'patch')
        return withStackedSurface(
            <Editor
                className="git-patch-editor h-full w-full"
                language="diff"
                path={`${gitDiffModelPath(sessionId, modelRepoId, document.path, 'modified')}.diff`}
                value={document.modified}
                theme="caxri-active"
                beforeMount={() => applyEditorTheme(theme)}
                onMount={(editor: Parameters<OnMount>[0]) => {
                    if (!stacked) return;
                    contentSizeListeners.current.push(
                        ...observeGitEditorContentHeight([editor], editor, onContentHeightChange),
                    );
                }}
                options={{
                    ...editorOptions,
                    glyphMargin: true,
                    readOnly: true,
                    wordWrap: 'off',
                    ...(stacked && { scrollbar: { alwaysConsumeMouseWheel: false } }),
                }}
            />,
        );
    return withStackedSurface(
        <GitMonacoDiffEditor
            stacked={stacked}
            original={document.original}
            modified={document.modified}
            originalLanguage={originalLanguage}
            modifiedLanguage={modifiedLanguage}
            originalModelPath={gitDiffModelPath(
                sessionId,
                modelRepoId,
                document.originalPath ?? document.path,
                'original',
            )}
            modifiedModelPath={gitDiffModelPath(sessionId, modelRepoId, document.path, 'modified')}
            theme="caxri-active"
            beforeMount={() => applyEditorTheme(theme)}
            onMount={(editor: Parameters<DiffOnMount>[0]) => {
                const actions = monacoDiffEditorActions(editor);
                editorReference.current = actions;
                diffEditorRegistrationReference.current?.();
                diffEditorRegistrationReference.current =
                    navigationKey && editorInstanceId
                        ? registerDiffEditorActions(navigationKey, editorInstanceId, actions)
                        : undefined;
                const original = editor.getOriginalEditor();
                const modified = editor.getModifiedEditor();
                const unbindOriginal = bindGitReviewCommentEditor(original, {
                    sessionId,
                    repositoryId,
                    sourceKey,
                    path: document.originalPath ?? document.path,
                    side: 'original',
                });
                const unbindModified = bindGitReviewCommentEditor(modified, {
                    sessionId,
                    repositoryId,
                    sourceKey,
                    path: document.path,
                    side: 'modified',
                });
                const heightListeners = stacked
                    ? observeGitEditorContentHeight(
                          [original, modified],
                          modified,
                          onContentHeightChange,
                      )
                    : [];
                return () =>
                    disposeAllThenRethrow([unbindOriginal, unbindModified, ...heightListeners]);
            }}
            options={{
                ...editorOptions,
                ...languageEditorOptions(modifiedLanguage),
                glyphMargin: true,
                originalEditable: false,
                readOnly: true,
                wordWrap: 'off',
                ...(stacked && {
                    scrollbar: { alwaysConsumeMouseWheel: false },
                }),
            }}
        />,
    );
}
