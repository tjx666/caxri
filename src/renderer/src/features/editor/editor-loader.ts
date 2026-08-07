import type { CodeEditor } from './CodeEditor';
import type * as MonacoApi from '../../lib/monaco';

const EDITOR_PRELOAD_MEASURE = 'caxri.editor.preload';

type CodeEditorModule = { CodeEditor: typeof CodeEditor };
type MonacoModule = typeof MonacoApi;

let dependenciesPromise: Promise<[CodeEditorModule, MonacoModule]> | undefined;
let loadedEditor: typeof CodeEditor | undefined;
let userLoadRequested = false;
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
    dependenciesPromise ??= Promise.all([import('./CodeEditor'), import('../../lib/monaco')]).catch(
        (error: unknown) => {
            dependenciesPromise = undefined;
            throw error;
        },
    );
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
    const [module] = await loadDependencies();
    return publishCodeEditor(module);
}

/** Idle work primes Monaco before any file selection without delaying a selection already in flight. */
async function preloadCodeEditor(): Promise<void> {
    performance.clearMarks('caxri.editor.preload-start');
    performance.clearMarks('caxri.editor.preload-ready');
    performance.clearMeasures(EDITOR_PRELOAD_MEASURE);
    performance.mark('caxri.editor.preload-start');
    const [module, { warmMonacoEditor }] = await loadDependencies();
    publishCodeEditor(module);
    if (!userLoadRequested) await warmMonacoEditor(() => !userLoadRequested);
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
