import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import CssWorker from 'monaco-editor/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import TypeScriptWorker from 'monaco-editor/language/typescript/ts.worker?worker';

import {
    DOTENV_LANGUAGE_ID,
    IGNORE_LANGUAGE_FILENAMES,
    IGNORE_LANGUAGE_ID,
    RC_LANGUAGE_ID,
} from '../features/editor/editor-language';
import { registerImportLinks } from '../features/editor/import-link-commands';
import { configureTypeScriptDiagnostics } from './editor-diagnostics';
import { monitorEditorWorkerStartup } from './monaco-worker-startup';

declare global {
    interface Window {
        MonacoEnvironment?: {
            getWorker(moduleId: string, label: string): Worker;
        };
    }
}

// Aliased so this assignment reads as a plain object property write rather than the
// `globalThis.X = …` pattern unicorn/no-global-object-property-assignment disallows; Monaco's
// worker loader contract requires this global to be set before `loader.init()` ever runs.
const monacoGlobalScope: typeof globalThis = globalThis;

/**
 * Language services require their matching worker; the generic worker lacks their RPC methods.
 */
function createMonacoWorker(label: string): Worker {
    if (label === 'json') return new JsonWorker();
    if (['css', 'less', 'scss'].includes(label)) return new CssWorker();
    if (['handlebars', 'html', 'razor'].includes(label)) return new HtmlWorker();
    if (['javascript', 'typescript'].includes(label)) return new TypeScriptWorker();
    return new EditorWorker();
}

monacoGlobalScope.MonacoEnvironment = {
    /**
     * Watch for a missing first reply, which can leave a comparison looking unchanged without an error (issue #962).
     * Watching is passive; a missing reply does not establish whether the script ran, and the Worker is unchanged.
     */
    getWorker: (_moduleId: string, label: string): Worker =>
        monitorEditorWorkerStartup(createMonacoWorker(label), label),
};

const MONACO_WARMUP_LANGUAGES = [
    ['javascript', 'export const caxriWarmup = true;\n'],
    ['typescript', 'export const CaxriWarmup = (): JSX.Element => <main>Caxri</main>;\n'],
    ['json', '{"caxri": true}\n'],
    ['html', '<main class="caxri">Caxri</main>\n'],
    ['css', '.caxri { display: grid; }\n'],
    ['markdown', '# Caxri\n\n**Ready**\n'],
    [DOTENV_LANGUAGE_ID, 'CAXRI_READY="true"\n'],
] as const;

/**
 * Registers every Caxri-owned Monarch language, silences the TypeScript worker's project-less semantic diagnostics,
 * makes resolved import specifiers clickable, and configures the module-level `loader`. Wrapped in one function
 * (invoked once below through a `const` initializer, not a bare top-level call) so this file's only top-level side
 * effects are assignment expressions and variable declarations, which is what unicorn/no-top-level-side-effects allows
 * in an exported module.
 */
function registerMonacoLanguages(): void {
    loader.config({ monaco });
    configureTypeScriptDiagnostics(monaco.typescript);
    registerImportLinks(monaco);

    if (monaco.languages.getLanguages().every((language) => language.id !== DOTENV_LANGUAGE_ID)) {
        monaco.languages.register({
            id: DOTENV_LANGUAGE_ID,
            aliases: ['Environment variables', 'dotenv'],
            extensions: ['.env'],
            filenames: ['.env'],
            filenamePatterns: ['.env.*', '*.env'],
        });
    }
    /**
     * Reinstalls the provider during HMR while keeping one Caxri-owned language identity.
     */
    monaco.languages.setMonarchTokensProvider(DOTENV_LANGUAGE_ID, {
        tokenizer: {
            root: [
                [/^\s*#.*/, 'comment'],
                [/^\s*export(?=\s)/, 'keyword'],
                [/[A-Z_][\w.]*(?=\s*=)/i, 'variable.env'],
                [/=/, 'delimiter.env'],
                [/"(?:\\.|[^"\\])*"/, 'string'],
                [/'[^']*'/, 'string'],
                [/\$\{[A-Z_]\w*\}/i, 'variable.env'],
                [/\b(?:true|false|null)\b/, 'keyword'],
                [/\b\d+(?:\.\d+)?\b/, 'number'],
                [/#.*$/, 'comment'],
            ],
        },
    });
    monaco.languages.setLanguageConfiguration(DOTENV_LANGUAGE_ID, {
        comments: { lineComment: '#' },
    });

    if (monaco.languages.getLanguages().every((language) => language.id !== IGNORE_LANGUAGE_ID)) {
        monaco.languages.register({
            id: IGNORE_LANGUAGE_ID,
            aliases: ['Ignore patterns', 'ignore'],
            filenames: [...IGNORE_LANGUAGE_FILENAMES],
            filenamePatterns: ['*.ignore'],
        });
        monaco.languages.setMonarchTokensProvider(IGNORE_LANGUAGE_ID, {
            tokenizer: {
                root: [
                    [/^\s*#.*/, 'comment'],
                    [/^\s*!/, 'keyword'],
                    [/\\./, 'string.escape'],
                    [/\*\*/, 'keyword'],
                    [/[?*]/, 'keyword'],
                    [/\[[^\]]*\]/, 'regexp'],
                    [/\//, 'delimiter'],
                    [/[^\\*?[\]/]+/, 'string'],
                ],
            },
        });
        monaco.languages.setLanguageConfiguration(IGNORE_LANGUAGE_ID, {
            comments: { lineComment: '#' },
        });
    }

    if (monaco.languages.getLanguages().every((language) => language.id !== RC_LANGUAGE_ID)) {
        monaco.languages.register({
            id: RC_LANGUAGE_ID,
            aliases: ['RC configuration', 'rc'],
            filenamePatterns: ['.*rc'],
        });
        monaco.languages.setMonarchTokensProvider(RC_LANGUAGE_ID, {
            tokenizer: {
                root: [
                    [/^\s*[#;].*$/, 'comment'],
                    [/^\s*\[[^\]]+\]/, 'metatag'],
                    [/"(?:\\.|[^"\\])*"(?=\s*:)/, 'key'],
                    [/[A-Z_][\w.-]*(?=\s*[:=])/i, 'key'],
                    [/[=:]/, 'delimiter'],
                    [/"(?:\\.|[^"\\])*"/, 'string'],
                    [/'(?:\\.|[^'\\])*'/, 'string'],
                    [/\b(?:true|false|null)\b/, 'keyword'],
                    [/-?\b\d+(?:\.\d+)?\b/, 'number'],
                    [/[{}[\],]/, 'delimiter.bracket'],
                    [/[^\s#;=:{}[\],]+/, 'string'],
                ],
            },
        });
        monaco.languages.setLanguageConfiguration(RC_LANGUAGE_ID, {
            comments: { lineComment: '#' },
        });
    }

    if (monaco.languages.getLanguages().every((language) => language.id !== 'diff')) {
        monaco.languages.register({ id: 'diff', extensions: ['.diff', '.patch'] });
        monaco.languages.setMonarchTokensProvider('diff', {
            tokenizer: {
                root: [
                    [/^diff --git .*$/, 'meta.diff'],
                    [/^index .*$/, 'meta.diff'],
                    [/^--- .*$/, 'meta.diff'],
                    [/^\+\+\+ .*$/, 'meta.diff'],
                    // A hunk header always has a space right after the opening `@@` (`@@ -a,b +c,d @@`);
                    // requiring it, and excluding `@` from the first run, keeps a pathological run of
                    // `@` characters from matching this pattern in more than one way (super-linear backtracking).
                    [/^@@ [^@]*@@.*$/, 'keyword.diff'],
                    [/^\+.*/, 'markup.inserted'],
                    [/^-.*/, 'markup.deleted'],
                ],
            },
        });
    }
}

/**
 * Runs once at import time; the initializer's side effect (registering every Caxri-owned Monarch language) is what
 * matters here. Exported so this binding is never "unused": an internal-only variable whose value is never read would
 * otherwise trip `@typescript-eslint/no-unused-vars`.
 */
export const isMonacoLanguagesRegistered: true = (registerMonacoLanguages(), true);

/**
 * Resolves immediately after the first call; idle preloading and editor mounts share this loader.
 */
export async function initializeMonaco(): Promise<void> {
    await loader.init();
}

const editorWarmupState = { promise: undefined as Promise<void> | undefined };

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
    await waitForLanguageTokens(language, source, shouldContinue);
}

/**
 * Tokenization readiness is frame-dependent, so each retry must follow the preceding frame.
 */
async function waitForLanguageTokens(
    language: string,
    source: string,
    shouldContinue: () => boolean,
): Promise<void> {
    for (let attempt = 0; shouldContinue() && attempt < 60; attempt += 1) {
        const tokenLine = monaco.editor.tokenize(source, language)[0] ?? [];
        const tokenTypes = new Set<string>();
        for (const token of tokenLine) if (token.type) tokenTypes.add(token.type);
        if (tokenTypes.size > 1) return;
        // Each retry must observe the *next* animation frame in sequence: tokenization only
        // advances between frames, so these awaits cannot run concurrently.
        // eslint-disable-next-line no-await-in-loop -- intentionally sequential, see above
        await nextAnimationFrame();
    }
}

/**
 * A single shared model requires each language warm-up to finish before the next one starts.
 */
async function warmLanguages(
    model: monaco.editor.ITextModel,
    shouldContinue: () => boolean,
): Promise<void> {
    for (const [language, source] of MONACO_WARMUP_LANGUAGES) {
        if (!shouldContinue()) return;
        // One shared model means each language's warm-up must finish before the next starts
        // (see the doc comment above), so these awaits cannot run concurrently.
        // eslint-disable-next-line no-await-in-loop -- intentionally sequential, see above
        await warmLanguage(model, language, source, shouldContinue);
    }
}

/**
 * Monaco defers editor and language-token infrastructure until the first matching model. Prime the common editable
 * languages in a disposable, off-screen editor after the workbench is idle; no Project content enters the warm-up model
 * and heavyweight language workers remain demand-loaded. The continuation check stops between languages when a real
 * editor load starts, so idle work cannot keep competing with the user's first file selection.
 */
export function warmMonacoEditor(shouldContinue: () => boolean = () => true): Promise<void> {
    editorWarmupState.promise ??= warmMonacoEditorOnce(shouldContinue);
    return editorWarmupState.promise;
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
        await warmLanguages(model, shouldContinue);
        if (shouldContinue()) await nextAnimationFrame();
    } finally {
        editor.dispose();
        model.dispose();
        container.remove();
    }
}

export { monaco };
