import { MAX_RESOLVED_IMPORTS } from '@caxri/protocol';
import { parseEditorModelPath } from '@desktop-shared/editor-state';
import type { CancellationToken, editor, IDisposable, languages, Uri } from 'monaco-editor';

import { caxri } from '../../lib/caxri';
import { openFileForSession } from './document-commands';
import { findRelativeImportSpecifiers } from './import-links';

/**
 * Languages whose relative imports this provider understands. JSON is deliberately absent: its `$ref` paths are not
 * module specifiers.
 */
const IMPORT_LINK_LANGUAGES = ['javascript', 'javascriptreact', 'typescript', 'typescriptreact'];

/**
 * Carries the already-resolved absolute path, and the Session it was resolved against, from the link to the opener. A
 * dedicated scheme rather than `file:` so this opener claims only the links it created and every other link keeps its
 * default handling.
 */
const IMPORT_LINK_SCHEME = 'caxri-import';

const IMPORT_LINK_TOOLTIP = '⌘ click to open';

/**
 * The `monaco` surface this module needs. Declared structurally so the registration can be exercised without booting
 * the real Monaco module, which only loads inside a browser environment.
 */
export interface ImportLinkMonaco {
    Uri: { from: (components: { authority: string; path: string; scheme: string }) => Uri };
    editor: { registerLinkOpener: (opener: { open: (resource: Uri) => boolean }) => IDisposable };
    languages: {
        registerLinkProvider: (
            languageSelector: string[],
            provider: languages.LinkProvider,
        ) => IDisposable;
    };
}

/**
 * Resolves the relative specifiers in one model against the Server, which is the only side that can tell whether
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
    const matches = findRelativeImportSpecifiers(model.getLinesContent(), MAX_RESOLVED_IMPORTS);
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
                        path,
                        scheme: IMPORT_LINK_SCHEME,
                    }),
                },
            ];
        }),
    };
}

/**
 * Makes the relative paths inside import statements clickable, opening the target in the current Session's editor.
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
                // Opened against the Session the link was resolved in, not the selected one, so a link clicked in a
                // background pane cannot land in another Session's editor.
                // eslint-disable-next-line no-void -- intentional floating-promise discard, openFileForSession reports its own errors
                void openFileForSession(resource.authority, resource.path);
                return true;
            },
        }),
    ];
}
