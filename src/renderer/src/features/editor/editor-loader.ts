import type CodeEditor from './CodeEditor';

const EDITOR_PRELOAD_MEASURE = 'caxri.editor.preload';

type CodeEditorModule = { default: typeof CodeEditor };

let modulePromise: Promise<CodeEditorModule> | undefined;
let loadedEditor: typeof CodeEditor | undefined;
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

/** Shares intent-driven loading and the idle preload so StrictMode never parses Monaco twice. */
export function loadCodeEditor(): Promise<CodeEditorModule> {
    if (modulePromise) return modulePromise;
    performance.clearMarks('caxri.editor.preload-start');
    performance.clearMarks('caxri.editor.preload-ready');
    performance.clearMeasures(EDITOR_PRELOAD_MEASURE);
    performance.mark('caxri.editor.preload-start');
    modulePromise = Promise.all([import('./CodeEditor'), import('../../lib/monaco')])
        .then(async ([module, { warmMonacoEditor }]) => {
            await warmMonacoEditor();
            loadedEditor = module.default;
            for (const listener of listeners) listener();
            performance.mark('caxri.editor.preload-ready');
            performance.measure(
                EDITOR_PRELOAD_MEASURE,
                'caxri.editor.preload-start',
                'caxri.editor.preload-ready',
            );
            return module;
        })
        .catch((error: unknown) => {
            modulePromise = undefined;
            throw error;
        });
    return modulePromise;
}

/** Starts after initial workbench work yields, without moving Monaco into the entry bundle. */
export function scheduleCodeEditorPreload(): () => void {
    let canceled = false;
    const preload = (): void => {
        if (!canceled) void loadCodeEditor().catch(() => undefined);
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
