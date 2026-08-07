import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import CssWorker from 'monaco-editor/language/css/css.worker?worker';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import TypeScriptWorker from 'monaco-editor/language/typescript/ts.worker?worker';

declare global {
    interface Window {
        MonacoEnvironment?: {
            getWorker(moduleId: string, label: string): Worker;
        };
    }
}

window.MonacoEnvironment = {
    /** Language services require their matching worker; the generic worker lacks their RPC methods. */
    getWorker: (_moduleId: string, label: string): Worker => {
        if (label === 'json') return new JsonWorker();
        if (['css', 'less', 'scss'].includes(label)) return new CssWorker();
        if (['handlebars', 'html', 'razor'].includes(label)) return new HtmlWorker();
        if (['javascript', 'typescript'].includes(label)) return new TypeScriptWorker();
        return new EditorWorker();
    },
};

loader.config({ monaco });

/** Resolves immediately after the first call; idle preloading and editor mounts share this loader. */
export async function initializeMonaco(): Promise<void> {
    await loader.init();
}

let editorWarmup: Promise<void> | undefined;

/**
 * Monaco defers most editor and JavaScript token infrastructure until the first `editor.create`,
 * which otherwise blocks the user's first file click. Prime that one-time path in a disposable,
 * off-screen editor after the workbench is idle; no Project content enters the warm-up model.
 */
export function warmMonacoEditor(): Promise<void> {
    editorWarmup ??= warmMonacoEditorOnce();
    return editorWarmup;
}

async function warmMonacoEditorOnce(): Promise<void> {
    await initializeMonaco();
    const container = document.createElement('div');
    container.setAttribute('aria-hidden', 'true');
    container.style.cssText =
        'position:fixed;left:-100px;top:-100px;width:1px;height:1px;opacity:0;pointer-events:none';
    document.body.append(container);
    const model = monaco.editor.createModel(
        '',
        undefined,
        monaco.Uri.parse('caxri://warmup/editor.js'),
    );
    const editor = monaco.editor.create(container, {
        automaticLayout: false,
        lineNumbers: 'off',
        minimap: { enabled: false },
        model,
        overviewRulerLanes: 0,
        readOnly: true,
    });
    try {
        const source = 'export const caxriWarmup = true;\n';
        monaco.editor.setModelLanguage(model, 'javascript');
        model.setValue(source);
        monaco.editor.tokenize(source, 'javascript');
        await new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
    } finally {
        editor.dispose();
        model.dispose();
        container.remove();
    }
}

if (!monaco.languages.getLanguages().some((language) => language.id === 'diff')) {
    monaco.languages.register({ id: 'diff', extensions: ['.diff', '.patch'] });
    monaco.languages.setMonarchTokensProvider('diff', {
        tokenizer: {
            root: [
                [/^diff --git .*$/, 'meta.diff'],
                [/^index .*$/, 'meta.diff'],
                [/^--- .*$/, 'meta.diff'],
                [/^\+\+\+ .*$/, 'meta.diff'],
                [/^@@.*@@.*$/, 'keyword.diff'],
                [/^\+.*/, 'markup.inserted'],
                [/^-.*/, 'markup.deleted'],
            ],
        },
    });
}

export { monaco };
