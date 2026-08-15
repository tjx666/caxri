import type { CodeEditor } from './code-editor';
import type * as MonacoApi from '../../lib/monaco';

const EDITOR_PRELOAD_MEASURE = 'caxri.editor.preload';

type CodeEditorModule = { CodeEditor: typeof CodeEditor };
type MonacoModule = typeof MonacoApi;

let dependenciesPromise: Promise<[CodeEditorModule, MonacoModule]> | undefined;
let loadedEditor: typeof CodeEditor | undefined;
let userLoadRequested = false;
/**
 * Bumped on every user-initiated load. Warm-up captures the generation it started with and keeps
 * running as long as no *further* user load has begun, so warm-up still completes when the user's
 * first load simply happened to race ahead of the idle preload (see editor-loader.test.ts).
 */
let loadGeneration = 0;
const listeners = new Set<() => void>();

export function getLoadedCodeEditor(): typeof loadedEditor {
    return loadedEditor;
}

export function subscribeLoadedCodeEditor(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

function loadDependencies(): Promise<[CodeEditorModule, MonacoModule]> {
    dependenciesPromise ??= Promise.all([
        import('./code-editor'),
        import('../../lib/monaco'),
    ]).catch((error: unknown) => {
        dependenciesPromise = undefined;
        throw error;
    });
    return dependenciesPromise;
}

function publishCodeEditor(module: CodeEditorModule): CodeEditorModule {
    if (loadedEditor) return module;
    loadedEditor = module.CodeEditor;
    for (const listener of listeners) listener();
    return module;
}

/** User intent publishes the real editor as soon as its module loads instead of blocking on warm-up. */
export async function loadCodeEditor(): Promise<CodeEditorModule> {
    userLoadRequested = true;
    loadGeneration += 1;
    const [module] = await loadDependencies();
    return publishCodeEditor(module);
}

/**
 * Idle work primes Monaco before any file selection without delaying a selection already in flight.
 * `warmMonacoEditor` is idempotent (module-cached promise), so it is always invoked here even when a
 * user load already published the real editor by the time idle work runs — otherwise a user opening a
 * file inside the up-to-1s `requestIdleCallback` window would permanently skip warm-up for the rest of
 * the app session. When the user has already requested a load, warm-up is only ever useful in the
 * background, so it runs without blocking (or being included in) the preload measurement.
 */
async function preloadCodeEditor(): Promise<void> {
    performance.clearMarks('caxri.editor.preload-start');
    performance.clearMarks('caxri.editor.preload-ready');
    performance.clearMeasures(EDITOR_PRELOAD_MEASURE);
    performance.mark('caxri.editor.preload-start');
    const [module, { warmMonacoEditor }] = await loadDependencies();
    publishCodeEditor(module);
    const startGeneration = loadGeneration;
    const shouldContinue = (): boolean => loadGeneration === startGeneration;
    const warmup = warmMonacoEditor(shouldContinue);
    if (userLoadRequested) {
        void warmup.catch(() => undefined);
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

/** Starts after initial workbench work yields, without moving Monaco into the entry bundle. */
export function scheduleCodeEditorPreload(): () => void {
    let canceled = false;
    const preload = (): void => {
        if (!canceled) void preloadCodeEditor().catch(() => undefined);
    };
    if (typeof window.requestIdleCallback === 'function') {
        const idleId = window.requestIdleCallback(preload, { timeout: 1_000 });
        return () => {
            canceled = true;
            window.cancelIdleCallback(idleId);
        };
    }
    const timer = window.setTimeout(preload, 0);
    return () => {
        canceled = true;
        window.clearTimeout(timer);
    };
}
