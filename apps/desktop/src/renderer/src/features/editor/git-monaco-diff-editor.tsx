import { useEffectEvent, useLayoutEffect, useMemo, useReducer, useRef } from 'react';

import type { DiffEditorProps, MonacoDiffEditor } from '@monaco-editor/react';
import type * as MonacoModule from 'monaco-editor';

import { cn } from '@/lib/utilities';

import { Empty, EmptyMedia, EmptyTitle } from '../../components/ui/empty';
import { Spinner } from '../../components/ui/spinner';
import { monaco } from '../../lib/monaco';
import { releaseStalledEditorWorkers } from '../../lib/monaco-worker-startup';
import { EditorLoadFailure } from './editor-load-failure';
import { editorLoadReducer, initialEditorLoadState } from './editor-load-state';
import { gitDiffComputationAction } from './git-diff-computation-state';
import { disposeGitDiffModels } from './git-diff-model-lifecycle';
import type { GitDiffComputationOutcome } from './git-diff-stall-watch';
import { gitDiffStallWatch } from './git-diff-stall-watch';
import { useGitDiffViewStore } from './git-diff-view-store';

const DIFF_RETRY_LABEL = 'Comparing these two versions again…';

type GitDiffEditorProperties = Omit<DiffEditorProps, 'onMount'> & {
    onMount?: (editor: MonacoDiffEditor, monaco: typeof MonacoModule) => void | (() => void);
    originalModelPath: string;
    modifiedModelPath: string;
    stacked: boolean;
};

/**
 * Explicit ownership lets unmount cancel diff work before disposing its text models.
 */
function GitDiffEditorSurface(
    properties: GitDiffEditorProperties & {
        onOutcome: (outcome: GitDiffComputationOutcome) => void;
    },
) {
    const inlineView = useGitDiffViewStore((state) => state.inlineView);
    const collapseUnchanged = useGitDiffViewStore(
        (state) => state.collapseUnchanged ?? properties.stacked,
    );
    const showWhitespaceDifferences = useGitDiffViewStore(
        (state) => state.showWhitespaceDifferences,
    );
    const options = useMemo(
        () => ({
            ...properties.options,
            renderSideBySide: !inlineView,
            useInlineViewWhenSpaceIsLimited: false,
            hideUnchangedRegions: { enabled: collapseUnchanged },
            ignoreTrimWhitespace: !showWhitespaceDifferences,
        }),
        [properties.options, inlineView, collapseUnchanged, showWhitespaceDifferences],
    );
    const container = useRef<HTMLDivElement>(null);
    const editor = useRef<MonacoDiffEditor | null>(null);
    const mountEditor = useEffectEvent(() => {
        if (!container.current) return;
        properties.beforeMount?.(monaco);
        const instance = monaco.editor.createDiffEditor(container.current, options);
        const models = {
            original: monaco.editor.createModel(
                properties.original ?? '',
                properties.originalLanguage,
                monaco.Uri.parse(properties.originalModelPath),
            ),
            modified: monaco.editor.createModel(
                properties.modified ?? '',
                properties.modifiedLanguage,
                monaco.Uri.parse(properties.modifiedModelPath),
            ),
        };
        const viewModel = instance.createViewModel(models);
        instance.setModel(viewModel);
        editor.current = instance;
        /**
         * Monaco opens a diff at line 1. In a thousand-line file whose change is near the bottom, that is a full screen
         * of identical imports and no visible diff at all — the file reads as unchanged until the user scrolls or
         * presses F7. `revealFirstDiff` waits for the diff computation and then centers the first change, which is what
         * every other diff viewer does on open. It runs on mount only: the in-place `setValue` path below is the same
         * file refreshing, and re-revealing there would yank the scroll position out from under the reader.
         */
        instance.revealFirstDiff();
        /**
         * Monaco computes the diff in a Web Worker, so a Worker that stops replying renders as an unchanged file rather
         * than an error. The watcher records that case (issue #962) and now also reports the outcome to this surface,
         * which is what lets a diff that never computed say so instead of passing for an unchanged file (issue #978).
         */
        const cancelStallWatch = gitDiffStallWatch.observe({
            waitForDiff: () => viewModel.waitForDiff(),
            readModels: () => ({
                originalLineCount: models.original.getLineCount(),
                modifiedLineCount: models.modified.getLineCount(),
                identicalModels: models.original.getValue() === models.modified.getValue(),
            }),
            onOutcome: (outcome) => properties.onOutcome(outcome),
        });
        const unmount = properties.onMount?.(instance, monaco);
        return () => {
            unmount?.();
            editor.current = null;
            cancelStallWatch();
            disposeGitDiffModels(instance, viewModel, models);
        };
    });
    useLayoutEffect(
        () => mountEditor(),
        [properties.originalModelPath, properties.modifiedModelPath],
    );
    useLayoutEffect(() => {
        editor.current?.updateOptions(options);
    }, [options]);
    useLayoutEffect(() => {
        const models = editor.current?.getModel();
        if (!models) return;
        if (models.original.getValue() !== properties.original)
            models.original.setValue(properties.original ?? '');
        if (models.modified.getValue() !== properties.modified)
            models.modified.setValue(properties.modified ?? '');
        if (properties.originalLanguage)
            monaco.editor.setModelLanguage(models.original, properties.originalLanguage);
        if (properties.modifiedLanguage)
            monaco.editor.setModelLanguage(models.modified, properties.modifiedLanguage);
    }, [
        properties.original,
        properties.modified,
        properties.originalLanguage,
        properties.modifiedLanguage,
    ]);
    return <div ref={container} className="h-full w-full" />;
}

/**
 * Owns what this diff surface is able to claim. Until the comparison answers, two panes with no highlights and an
 * unchanged file are the same picture, so the outcome of each attempt decides whether the panes may be shown at all.
 *
 * Retry re-keys the editor rather than poking it: a diff is computed once per view model, so asking again means
 * building a new one, and an unmount is what releases the models the abandoned attempt still held.
 */
export function GitMonacoDiffEditor(properties: GitDiffEditorProperties) {
    const [computation, dispatchComputation] = useReducer(
        editorLoadReducer,
        initialEditorLoadState,
    );
    const attempt = computation.attempt;
    const isStalled = computation.status === 'failed';
    /**
     * Only a retry gets a progress state. The first comparison resolves in well under a frame on any ordinary file, so
     * announcing it would be a flicker; a retry is a request the user made by hand after being told nothing worked, and
     * that one has to visibly do something.
     */
    const isRetrying = computation.status === 'loading' && attempt > 0;
    const isCovered = isStalled || isRetrying;
    return (
        <div className="relative h-full w-full">
            {/* The editor keeps its element and its models while a cover is up: hiding the panes is what stops them
                being read as a verdict, and unmounting them would throw away a comparison that may still arrive. */}
            <div className={cn('h-full w-full', isCovered && 'invisible')}>
                <GitDiffEditorSurface
                    key={attempt}
                    {...properties}
                    onOutcome={(outcome) =>
                        dispatchComputation(gitDiffComputationAction(outcome, attempt))
                    }
                />
            </div>
            {isCovered && (
                <div className="absolute inset-0 grid place-items-center bg-background">
                    {isStalled ? (
                        <EditorLoadFailure
                            actionLabel="Retry"
                            reason={computation.reason}
                            onAction={() => {
                                /**
                                 * Releasing first is what makes the retry different from the one that already failed: a
                                 * Worker that never started keeps being handed to every later comparison, so a new view
                                 * model alone would queue behind the same dead Worker. See issue #962.
                                 */
                                releaseStalledEditorWorkers();
                                dispatchComputation({ type: 'retried' });
                            }}
                        />
                    ) : (
                        <Empty className="empty-work h-full flex-1">
                            <EmptyMedia>
                                <Spinner className="size-7" />
                            </EmptyMedia>
                            <EmptyTitle className="max-w-80 text-pretty text-muted">
                                {DIFF_RETRY_LABEL}
                            </EmptyTitle>
                        </Empty>
                    )}
                </div>
            )}
        </div>
    );
}
