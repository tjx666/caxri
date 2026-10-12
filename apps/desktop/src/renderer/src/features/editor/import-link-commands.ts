import { isVirtualEditorTabPath, MAX_RESOLVED_IMPORTS } from '@caxri/protocol';
import { editorModelPath, parseEditorModelPath } from '@desktop-shared/editor-state';
import type { CancellationToken, editor, IDisposable, languages, Uri } from 'monaco-editor';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { getSelectedSession } from '../../stores/selectors';
import { sessionViewScope } from '../../stores/session-view';
import { pushToast } from '../../stores/toasts';
import { getActivePaneId, getActivePaneTab } from '../workbench/pane-actions';
import { openFileForSession } from './document-commands';
import { mountedEditor } from './editor-reveal';
import { findImportSpecifiers, importSpecifierAtPosition } from './import-links';

/**
 * Languages whose imports this provider understands. JSON is deliberately absent: its `$ref` paths are not module
 * specifiers.
 */
const IMPORT_LINK_LANGUAGES = ['javascript', 'javascriptreact', 'typescript', 'typescriptreact'];

/**
 * Carries the importing document, specifier and Session from the link to the opener. A dedicated scheme rather than
 * `file:` so this opener claims only the links it created and every other link keeps its default handling.
 */
const IMPORT_LINK_SCHEME = 'caxri-import';

const IMPORT_LINK_TOOLTIP = '⌘ click to open';

/**
 * The `monaco` surface this module needs. Declared structurally so the registration can be exercised without booting
 * the real Monaco module, which only loads inside a browser environment.
 */
export interface ImportLinkMonaco {
    Uri: {
        from: (components: {
            authority: string;
            path: string;
            query: string;
            scheme: string;
        }) => Uri;
    };
    editor: { registerLinkOpener: (opener: { open: (resource: Uri) => boolean }) => IDisposable };
    languages: {
        registerLinkProvider: (
            languageSelector: string[],
            provider: languages.LinkProvider,
        ) => IDisposable;
    };
}

/**
 * Resolves the specifiers in one model against the Server, which is the only side that can tell whether
 * `'../../errors'` is `errors.ts`, `errors/index.ts`, or nothing at all. Returning no link for an unresolved specifier
 * is the point: a `tsconfig` alias or a package name must not render as a link that jumps somewhere wrong.
 */
async function provideImportLinks(
    monaco: ImportLinkMonaco,
    model: editor.ITextModel,
    token: CancellationToken,
): Promise<languages.ILinksList> {
    // Only a real Project document has relative siblings; a Git diff, a transcript, and an externally authorized file
    // all carry a URI this rejects.
    const document = parseEditorModelPath(model.uri);
    if (!document) return { links: [] };
    const matches = findImportSpecifiers(model.getLinesContent(), MAX_RESOLVED_IMPORTS);
    if (matches.length === 0) return { links: [] };
    let resolved: Array<{ path: string; specifier: string }>;
    try {
        ({ resolved } = await caxri.request('files.resolveImports', {
            sessionId: document.sessionId,
            from: document.path,
            specifiers: matches.map((match) => match.specifier),
        }));
    } catch {
        // A link pass is speculative: the document is readable whether or not its imports became clickable, so a
        // failed resolution stays silent rather than pushing a toast the user never asked for.
        return { links: [] };
    }
    if (token.isCancellationRequested) return { links: [] };
    const paths = new Map(resolved.map((entry) => [entry.specifier, entry.path]));
    return {
        links: matches.flatMap((match) => {
            const path = paths.get(match.specifier);
            if (!path) return [];
            return [
                {
                    range: {
                        startLineNumber: match.lineNumber,
                        startColumn: match.startColumn,
                        endLineNumber: match.lineNumber,
                        endColumn: match.endColumn,
                    },
                    tooltip: IMPORT_LINK_TOOLTIP,
                    url: monaco.Uri.from({
                        authority: document.sessionId,
                        path: document.path,
                        query: new URLSearchParams({ specifier: match.specifier }).toString(),
                        scheme: IMPORT_LINK_SCHEME,
                    }),
                },
            ];
        }),
    };
}

/**
 * Makes resolved import specifiers clickable, opening the target in the current Session's editor.
 *
 * Registered once for the whole application rather than per editor instance: Monaco keys link providers by language,
 * and a second registration would offer every link twice.
 */
export function registerImportLinks(monaco: ImportLinkMonaco): IDisposable[] {
    return [
        monaco.languages.registerLinkProvider(IMPORT_LINK_LANGUAGES, {
            provideLinks: (model, token) => provideImportLinks(monaco, model, token),
        }),
        monaco.editor.registerLinkOpener({
            open: (resource) => {
                if (resource.scheme !== IMPORT_LINK_SCHEME) return false;
                const specifier = new URLSearchParams(resource.query).get('specifier');
                if (!specifier) return false;
                // Opened against the Session the link was resolved in, not the selected one, so a link clicked in a
                // background pane cannot land in another Session's editor.
                // eslint-disable-next-line no-void -- intentional floating-promise discard, resolveAndOpenImport reports errors
                void resolveAndOpenImport(resource.authority, resource.path, specifier);
                return true;
            },
        }),
    ];
}

/**
 * The Monaco instance rendering the active file tab, or nothing when the active work item is a Terminal, a diff, or any
 * other virtual document that owns no relative siblings.
 */
function activeFileEditor(): editor.IStandaloneCodeEditor | undefined {
    const session = getSelectedSession();
    const tab = getActivePaneTab();
    if (!session || tab?.resource.kind !== 'file') return undefined;
    if (isVirtualEditorTabPath(tab.resource.path)) return undefined;
    const scope = sessionViewScope(session.id, session.workbenchProjectId);
    return mountedEditor(editorModelPath(scope, tab.resource.path), getActivePaneId());
}

/**
 * Gate for `editor.openImportLink`: an ordinary file editor is on screen to read a caret from.
 */
export function canOpenImportLinkAtCursor(): boolean {
    return activeFileEditor() !== undefined;
}

/**
 * Opens the file named by the import under the caret: the keyboard half of ⌘-clicking the same path, which until now
 * was the only way to follow one.
 *
 * Resolved here rather than by running Monaco's own `editor.action.openLink`: that action reads whatever the link
 * detector last computed, so it silently does nothing while a pass is still in flight, and it cannot tell "no link
 * here" apart from "not scanned yet". A command invoked from the palette has to answer the user either way.
 */
export async function openImportLinkAtCursor(): Promise<void> {
    const editorInstance = activeFileEditor();
    const model = editorInstance?.getModel();
    const position = editorInstance?.getPosition();
    if (!model || !position) return;
    const document = parseEditorModelPath(model.uri);
    if (!document) return;
    const match = importSpecifierAtPosition(
        findImportSpecifiers(model.getLinesContent(), MAX_RESOLVED_IMPORTS),
        position.lineNumber,
        position.column,
    );
    if (!match) {
        pushToast('info', translate('editor.importLink.noImport'));
        return;
    }
    await resolveAndOpenImport(document.sessionId, document.path, match.specifier);
}

/**
 * Re-resolve at activation so cached Monaco links cannot open an old target after a config edit.
 */
async function resolveAndOpenImport(
    sessionId: string,
    from: string,
    specifier: string,
): Promise<void> {
    let resolved: Array<{ path: string; specifier: string }>;
    try {
        ({ resolved } = await caxri.request('files.resolveImports', {
            sessionId,
            from,
            specifiers: [specifier],
        }));
    } catch {
        pushToast('error', translate('editor.importLink.resolveFailed', { specifier }));
        return;
    }
    const path = resolved.find((entry) => entry.specifier === specifier)?.path;
    if (!path) {
        pushToast('info', translate('editor.importLink.notInProject', { specifier }));
        return;
    }
    await openFileForSession(sessionId, path);
}
