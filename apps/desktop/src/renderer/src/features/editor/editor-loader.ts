import { notifyListeners } from '@caxri/utils';

import type * as MonacoApi from '../../lib/monaco';
import type { CodeEditor } from './code-editor';

const EDITOR_PRELOAD_MEASURE = 'caxri.editor.preload';

interface CodeEditorModule {
    CodeEditor: typeof CodeEditor;
}
type MonacoModule = typeof MonacoApi;

/**
 * Mutable module state grouped behind a single object so functions below mutate a property instead of reassigning a
 * top-level binding (`unicorn/no-top-level-assignment-in-function`).
 */
const state: {
    dependenciesPromise: Promise<[CodeEditorModule, MonacoModule]> | undefined;
    loadedEditor: typeof CodeEditor | undefined;
    isUserLoadRequested: boolean;
    /**
     * Bumped on every user-initiated load. Warm-up captures the generation it started with and keeps running as long as
     * no _further_ user load has begun, so warm-up still completes when the user's first load simply happened to race
     * ahead of the idle preload (see editor-loader.test.ts).
     */
    loadGeneration: number;
} = {
    dependenciesPromise: undefined,
    loadedEditor: undefined,
    isUserLoadRequested: false,
    loadGeneration: 0,
};
const listeners = new Set<() => void>();

export function getLoadedCodeEditor(): typeof state.loadedEditor {
    return state.loadedEditor;
}

export function subscribeLoadedCodeEditor(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

async function loadDependenciesUncached(): Promise<[CodeEditorModule, MonacoModule]> {
    try {
        return await Promise.all([import('./code-editor'), import('../../lib/monaco')]);
    } catch (error) {
        state.dependenciesPromise = undefined;
        throw error;
    }
}

function loadDependencies(): Promise<[CodeEditorModule, MonacoModule]> {
    state.dependenciesPromise ??= loadDependenciesUncached();
    return state.dependenciesPromise;
}

function publishCodeEditor(module: CodeEditorModule): CodeEditorModule {
    if (state.loadedEditor) return module;
    state.loadedEditor = module.CodeEditor;
    // Isolates each editor-loaded subscriber so one throwing surface cannot stop the other mounted editors from
    // observing that the real editor module is ready; Desktop mirrors `console.error` into `logs/desktop.jsonl`.
    notifyListeners(listeners, undefined, (error) =>
        console.error('editor.codeEditorLoaded listener failed', error),
    );
    return module;
}

/**
 * User intent publishes the real editor as soon as its module loads instead of blocking on warm-up.
 */
export async function loadCodeEditor(): Promise<CodeEditorModule> {
    state.isUserLoadRequested = true;
    state.loadGeneration += 1;
    const [module] = await loadDependencies();
    return publishCodeEditor(module);
}

/**
 * Idle work primes Monaco before any file selection without delaying a selection already in flight. `warmMonacoEditor`
 * is idempotent (module-cached promise), so it is always invoked here even when a user load already published the real
 * editor by the time idle work runs; otherwise a user opening a file inside the up-to-1s `requestIdleCallback` window
 * would permanently skip warm-up for the rest of the app session. When the user has already requested a load, warm-up
 * is only ever useful in the background, so it runs without blocking (or being included in) the preload measurement.
 */
async function preloadCodeEditor(): Promise<void> {
    performance.clearMarks('caxri.editor.preload-start');
    performance.clearMarks('caxri.editor.preload-ready');
    performance.clearMeasures(EDITOR_PRELOAD_MEASURE);
    performance.mark('caxri.editor.preload-start');
    const [module, { warmMonacoEditor }] = await loadDependencies();
    publishCodeEditor(module);
    const startGeneration = state.loadGeneration;
    const shouldContinue = (): boolean => state.loadGeneration === startGeneration;
    const warmup = warmMonacoEditor(shouldContinue);
    if (state.isUserLoadRequested) {
        // Warm-up only matters in the background once a user load is already in flight; a failure
        // here has nothing left to report to, so it is intentionally swallowed.
        try {
            await warmup;
        } catch {
            // ignored: background warm-up failures do not affect the user-requested load.
        }
    } else {
        await warmup;
    }
    performance.mark('caxri.editor.preload-ready');
    performance.measure(
        EDITOR_PRELOAD_MEASURE,
        'caxri.editor.preload-start',
        'caxri.editor.preload-ready',
    );
}

/**
 * Starts after initial workbench work yields, without moving Monaco into the entry bundle.
 */
async function preloadCodeEditorIgnoringFailure(): Promise<void> {
    try {
        await preloadCodeEditor();
    } catch {
        // ignored: idle preload has no UI surface to report a failure through; a later user-driven
        // `loadCodeEditor()` call will surface the same error if the module truly cannot load.
    }
}

export function scheduleCodeEditorPreload(): () => void {
    let isCanceled = false;
    const preload = (): void => {
        if (isCanceled) return;
        // Fire-and-forget: failures are already funneled into `preloadCodeEditorIgnoringFailure`
        // above, so there is nothing left for this scheduler to await or react to.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void preloadCodeEditorIgnoringFailure();
    };
    if (typeof requestIdleCallback === 'function') {
        const idleId = requestIdleCallback(preload, { timeout: 1_000 });
        return () => {
            isCanceled = true;
            cancelIdleCallback(idleId);
        };
    }
    const timer = setTimeout(preload, 0);
    return () => {
        isCanceled = true;
        clearTimeout(timer);
    };
}
