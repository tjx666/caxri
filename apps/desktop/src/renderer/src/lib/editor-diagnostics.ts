import type { typescript } from 'monaco-editor';

/**
 * The `monaco.typescript` surface this module touches: monaco-editor 0.56 moved it out of the now-deprecated
 * `monaco.languages.typescript`. Declared structurally so a test can pass a recorder instead of booting the real Monaco
 * module, which only loads inside a browser/worker environment.
 */
export interface TypeScriptLanguageDefaults {
    javascriptDefaults: Pick<typescript.LanguageServiceDefaults, 'setDiagnosticsOptions'>;
    typescriptDefaults: Pick<typescript.LanguageServiceDefaults, 'setDiagnosticsOptions'>;
}

/**
 * Monaco's bundled TypeScript worker type-checks only the models currently open in the editor: it never reads the
 * workspace `tsconfig.json` and never resolves `node_modules`. Every cross-file and cross-package type therefore fails
 * to resolve and decays into TypeScript's internal error type, so the worker reports confident nonsense: `Cannot find
 * module 'openai'`, plus cascades of assignability errors that print the unresolved names as if they were the property
 * types. Caxri has no TypeScript project service feeding the worker a real dependency graph, so semantic and suggestion
 * diagnostics here can only ever be false positives. Syntax diagnostics need nothing beyond the open document and stay
 * on.
 *
 * See https://github.com/tjx666/caxri/issues/921.
 */
const editorTypeScriptDiagnosticsOptions: typescript.DiagnosticsOptions = {
    noSemanticValidation: true,
    noSuggestionDiagnostics: true,
    noSyntaxValidation: false,
};

/**
 * Applies {@link editorTypeScriptDiagnosticsOptions} to both language services. JavaScript shares the same worker and
 * the same missing project context, so it needs the identical treatment.
 */
export function configureTypeScriptDiagnostics(defaults: TypeScriptLanguageDefaults): void {
    defaults.typescriptDefaults.setDiagnosticsOptions(editorTypeScriptDiagnosticsOptions);
    defaults.javascriptDefaults.setDiagnosticsOptions(editorTypeScriptDiagnosticsOptions);
}
