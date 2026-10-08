import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    openFileForSession: vi.fn(() => Promise.resolve('/opened')),
    request: vi.fn(() => Promise.resolve({ resolved: [] as Array<Record<string, string>> })),
}));
vi.mock('../../../lib/caxri', () => ({ caxri: { request: mocks.request } }));
vi.mock('../document-commands', () => ({ openFileForSession: mocks.openFileForSession }));

import type { ImportLinkMonaco } from '../import-link-commands';
import { registerImportLinks } from '../import-link-commands';

interface FakeUri {
    authority: string;
    path: string;
    scheme: string;
    query?: string;
}

const registered = {
    open: undefined as ((resource: FakeUri) => boolean) | undefined,
    provideLinks: undefined as
        ((model: unknown, token: unknown) => Promise<{ links: unknown[] }>) | undefined,
};

const monaco = {
    Uri: { from: (components: FakeUri) => components },
    editor: {
        registerLinkOpener: (opener: { open: (resource: FakeUri) => boolean }) => {
            registered.open = opener.open;
            return { dispose: () => {} };
        },
    },
    languages: {
        registerLinkProvider: (_languages: string[], provider: { provideLinks: unknown }) => {
            registered.provideLinks = provider.provideLinks as typeof registered.provideLinks;
            return { dispose: () => {} };
        },
    },
} as unknown as ImportLinkMonaco;

registerImportLinks(monaco);

/**
 * Stands in for the Monaco model of a Session-scoped document, whose URI carries the Session and the real path: the
 * shape `editorModelPath` produces and Monaco hands back already percent-decoded.
 */
function model(lines: string[], uri: Partial<FakeUri> = {}) {
    return {
        getLinesContent: () => lines,
        uri: {
            authority: 'session',
            path: '/session-a/project/src/app.ts',
            scheme: 'caxri',
            ...uri,
        },
    };
}

const token = { isCancellationRequested: false };

function provide(...parameters: Parameters<typeof model>) {
    return registered.provideLinks!(model(...parameters), token);
}

afterEach(() => {
    mocks.openFileForSession.mockClear();
    mocks.request.mockClear();
});

describe('import links', () => {
    it('resolves a document against the Session its model URI names, not the selected one', async () => {
        await provide(["import { a } from './sibling';"]);

        expect(mocks.request).toHaveBeenCalledWith('files.resolveImports', {
            sessionId: 'session-a',
            from: '/project/src/app.ts',
            specifiers: ['./sibling'],
        });
    });

    it('links only the specifiers the Server resolved to a real file', async () => {
        mocks.request.mockResolvedValueOnce({
            resolved: [{ path: '/project/src/sibling.ts', specifier: './sibling' }],
        });

        const { links } = await provide([
            "import { a } from './sibling';",
            "import { b } from '@/alias';",
            "import c from 'package';",
        ]);

        expect(links).toEqual([
            {
                range: {
                    startLineNumber: 1,
                    startColumn: 20,
                    endLineNumber: 1,
                    endColumn: 29,
                },
                tooltip: '⌘ click to open',
                url: {
                    authority: 'session-a',
                    path: '/project/src/app.ts',
                    query: 'specifier=.%2Fsibling',
                    scheme: 'caxri-import',
                },
            },
        ]);
    });

    it('leaves a Git diff, a transcript, and an external document alone', async () => {
        for (const uri of [
            { authority: '', path: '/project/src/app.ts', scheme: 'file' },
            { authority: 'agent-transcript', path: '/terminal-1.jsonl', scheme: 'caxri' },
            { authority: 'session', path: '/session-a/external/doc-1/app.ts', scheme: 'caxri' },
        ]) {
            // eslint-disable-next-line no-await-in-loop -- one shared request spy, asserted per URI
            const { links } = await provide(["import { a } from './sibling';"], uri);
            expect(links).toEqual([]);
        }
        expect(mocks.request).not.toHaveBeenCalled();
    });

    it('stays silent when the Server cannot resolve the document', async () => {
        mocks.request.mockRejectedValueOnce(new Error('NOT_FOUND'));

        await expect(provide(["import { a } from './sibling';"])).resolves.toEqual({ links: [] });
    });

    it('re-resolves its links against their Session at activation and declines every other scheme', async () => {
        mocks.request.mockResolvedValueOnce({
            resolved: [{ specifier: '@/alias', path: '/project/new-target.ts' }],
        });
        expect(
            registered.open!({
                authority: 'session-a',
                path: '/project/src/app.ts',
                query: 'specifier=%40%2Falias',
                scheme: 'caxri-import',
            }),
        ).toBe(true);
        await vi.waitFor(() =>
            expect(mocks.openFileForSession).toHaveBeenCalledWith(
                'session-a',
                '/project/new-target.ts',
            ),
        );

        expect(registered.open!({ authority: '', path: '/etc/passwd', scheme: 'file' })).toBe(
            false,
        );
        expect(mocks.openFileForSession).toHaveBeenCalledTimes(1);
    });
});
