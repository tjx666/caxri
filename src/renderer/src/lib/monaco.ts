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

const DOTENV_LANGUAGE_ID = 'dotenv';

if (!monaco.languages.getLanguages().some((language) => language.id === DOTENV_LANGUAGE_ID)) {
    monaco.languages.register({
        id: DOTENV_LANGUAGE_ID,
        aliases: ['Environment variables', 'dotenv'],
        extensions: ['.env'],
        filenames: ['.env'],
        filenamePatterns: ['.env.*', '*.env'],
    });
    monaco.languages.setMonarchTokensProvider(DOTENV_LANGUAGE_ID, {
        tokenizer: {
            root: [
                [/^\s*#.*/, 'comment'],
                [/^\s*export(?=\s+)/, 'keyword'],
                [/[A-Za-z_][\w.]*(?=\s*=)/, 'variable.env'],
                [/=/, 'delimiter.env'],
                [/"(?:\\.|[^"\\])*"/, 'string'],
                [/'[^']*'/, 'string'],
                [/\$\{[A-Za-z_][\w]*\}/, 'variable.env'],
                [/\b(?:true|false|null)\b/, 'keyword'],
                [/\b\d+(?:\.\d+)?\b/, 'number'],
                [/#.*$/, 'comment'],
            ],
        },
    });
}

/** Resolves immediately after the first call; idle preloading and editor mounts share this loader. */
export async function initializeMonaco(): Promise<void> {
    await loader.init();
}

let editorWarmup: Promise<void> | undefined;

function nextAnimationFrame(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function warmLanguage(
    model: monaco.editor.ITextModel,
    language: string,
    source: string,
    shouldContinue: () => boolean,
): Promise<void> {
    monaco.editor.setModelLanguage(model, language);
    model.setValue(source);
    for (let attempt = 0; attempt < 60; attempt += 1) {
        if (!shouldContinue()) return;
        const tokens = monaco.editor.tokenize(source, language)[0] ?? [];
        if (new Set(tokens.map((token) => token.type).filter(Boolean)).size > 1) return;
        await nextAnimationFrame();
    }
}

/**
 * Monaco defers editor and language-token infrastructure until the first matching model. Prime the
 * common editable languages in a disposable, off-screen editor after the workbench is idle; no
 * Project content enters the warm-up model and heavyweight language workers remain demand-loaded.
 * The continuation check stops between languages when a real editor load starts, so idle work
 * cannot keep competing with the user's first file selection.
 */
export function warmMonacoEditor(shouldContinue: () => boolean = () => true): Promise<void> {
    editorWarmup ??= warmMonacoEditorOnce(shouldContinue);
    return editorWarmup;
}

async function warmMonacoEditorOnce(shouldContinue: () => boolean): Promise<void> {
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
        for (const [language, source] of [
            ['javascript', 'export const caxriWarmup = true;\n'],
            ['typescript', 'export const CaxriWarmup = (): JSX.Element => <main>Caxri</main>;\n'],
            ['json', '{"caxri": true}\n'],
            ['html', '<main class="caxri">Caxri</main>\n'],
            ['css', '.caxri { display: grid; }\n'],
            ['markdown', '# Caxri\n\n**Ready**\n'],
            [DOTENV_LANGUAGE_ID, 'CAXRI_READY="true"\n'],
        ] as const) {
            if (!shouldContinue()) break;
            await warmLanguage(model, language, source, shouldContinue);
        }
        if (shouldContinue()) await nextAnimationFrame();
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
