import {
    agentTranscriptTabPath,
    externalEditorTabPath,
    filePreviewTabPath,
    gitChangesDiffTabPath,
    gitCommitFileDiffTabPath,
    gitFileDiffTabPath,
} from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    documentTabDesktopActionState,
    documentTabPathMenuState,
    editorTabActionsPath,
    resolveDocumentTabPath,
} from '../document-tab-path-actions';

const repositories = [
    { id: 'primary', rootPath: '/project' },
    { id: 'nested', rootPath: '/project/packages/nested' },
    { id: 'submodule', rootPath: '/project/vendor/sub' },
    { id: 'linked', rootPath: '/elsewhere/linked' },
] as const;

describe('editorTabActionsPath', () => {
    const fileTab = (path: string) => ({ id: 'tab', resource: { kind: 'file' as const, path } });

    it('gives Project files, diffs, and external documents a tab action slot', () => {
        const external = externalEditorTabPath('external-1', 'guide.md');
        const diff = gitFileDiffTabPath('primary', 'README.md');
        for (const path of ['/project/README.md', diff, external])
            expect(editorTabActionsPath(fileTab(path))).toBe(path);
        const preview = fileTab(filePreviewTabPath(external));
        expect(editorTabActionsPath(preview)).toBeUndefined();
        expect(editorTabActionsPath(undefined)).toBeUndefined();
    });
});

describe('documentTabPathMenuState', () => {
    const loaded = { isError: false, isPending: false };
    it('offers external absolute paths and single-file diffs but not aggregate virtual documents', () => {
        expect(
            documentTabPathMenuState(externalEditorTabPath('external-1', 'outside.ts'), loaded),
        ).toMatchObject({ externalDocumentId: 'external-1', showMenu: true });
        expect(documentTabPathMenuState('/project/file.ts', loaded)).not.toHaveProperty(
            'externalDocumentId',
        );
        expect(documentTabPathMenuState('/project/file.ts', loaded).showMenu).toBe(true);
        expect(
            documentTabPathMenuState(gitFileDiffTabPath('primary', 'file.ts'), loaded).showMenu,
        ).toBe(true);
        expect(
            documentTabPathMenuState(gitChangesDiffTabPath('primary', 'project'), loaded).showMenu,
        ).toBe(false);
        expect(
            documentTabPathMenuState(agentTranscriptTabPath('terminal-1'), loaded).showMenu,
        ).toBe(false);
    });
    it('distinguishes loading, failed, and unavailable repository paths', () => {
        expect(
            documentTabPathMenuState('/project/file.ts', { isError: false, isPending: true })
                .unavailableReason,
        ).toBe('Repository information is still loading');
        expect(
            documentTabPathMenuState('/project/file.ts', { isError: true, isPending: false })
                .unavailableReason,
        ).toBe('Unable to load repository information');
        expect(documentTabPathMenuState('/project/file.ts', loaded).unavailableReason).toBe(
            'The file path is unavailable',
        );
    });
});

describe('resolveDocumentTabPath', () => {
    it('copies the Main-authorized display path of an external document without a Project root', () => {
        expect(
            resolveDocumentTabPath(externalEditorTabPath('external-1', 'outside.ts'), {
                externalDisplayPath: '/outside/outside.ts',
            }),
        ).toEqual({ absolutePath: '/outside/outside.ts' });
    });

    /**
     * A submodule and a nested repository are the only files where the two `Copy Relative Path` entries used to
     * disagree, the tab measuring from the inner repository and the Files tree from the Project. The Project root is
     * the one basis now, so the tab reports what the tree reports for the same file.
     */
    it.each([
        { basis: 'submodule', path: '/project/vendor/sub/src/index.ts' },
        { basis: 'nested repository', path: '/project/packages/nested/lib/a.ts' },
        { basis: 'plain directory', path: '/project/notes.txt' },
    ])('measures a file in a $basis from the Project root', ({ path }) => {
        expect(resolveDocumentTabPath(path, { projectRoot: '/project', repositories })).toEqual({
            absolutePath: path,
            relativeRoot: '/project',
        });
    });

    it('resolves a single-file diff URI to the same Project-relative basis', () => {
        expect(
            resolveDocumentTabPath(gitFileDiffTabPath('submodule', 'src/index.ts'), {
                projectRoot: '/project',
                repositories,
            }),
        ).toEqual({
            absolutePath: '/project/vendor/sub/src/index.ts',
            relativeRoot: '/project',
        });
        expect(
            resolveDocumentTabPath(
                gitCommitFileDiffTabPath(
                    'nested',
                    '0123456789abcdef0123456789abcdef01234567',
                    'lib/a.ts',
                ),
                { projectRoot: '/project', repositories },
            ),
        ).toEqual({
            absolutePath: '/project/packages/nested/lib/a.ts',
            relativeRoot: '/project',
        });
    });

    /**
     * A Git tab can be opened from a linked repository that no Project root contains. There is no Project-relative path
     * to report for it, so its own repository root stays the basis rather than leaving nothing to copy.
     */
    it('keeps the repository basis for a diff opened outside the Project', () => {
        expect(
            resolveDocumentTabPath(gitFileDiffTabPath('linked', 'src/index.ts'), {
                projectRoot: '/project',
                repositories,
            }),
        ).toEqual({
            absolutePath: '/elsewhere/linked/src/index.ts',
            relativeRoot: '/elsewhere/linked',
        });
    });

    it('does not invent one path for multi-file, transcript, or external virtual tabs', () => {
        expect(
            resolveDocumentTabPath(gitChangesDiffTabPath('primary', 'project'), {
                projectRoot: '/project',
                repositories,
            }),
        ).toBeUndefined();
        expect(
            resolveDocumentTabPath(agentTranscriptTabPath('terminal-1'), {
                projectRoot: '/project',
                repositories,
            }),
        ).toBeUndefined();
        expect(
            resolveDocumentTabPath(externalEditorTabPath('external-1', 'outside.ts'), {
                projectRoot: '/project',
                repositories,
            }),
        ).toBeUndefined();
    });

    it('rejects ordinary paths outside the authorized Workbench Project', () => {
        expect(
            resolveDocumentTabPath('/other/outside.ts', {
                projectRoot: '/project',
                repositories,
            }),
        ).toBeUndefined();
    });

    it('offers an ordinary file its relative basis before the Git overview loads', () => {
        expect(
            resolveDocumentTabPath('/project/notes.txt', {
                projectRoot: '/project',
                repositories: [],
            }),
        ).toEqual({ absolutePath: '/project/notes.txt', relativeRoot: '/project' });
        // The Files tree row for the same file never waits for repository data, so neither does the tab.
        expect(resolveDocumentTabPath('/project/notes.txt', { projectRoot: '/project' })).toEqual({
            absolutePath: '/project/notes.txt',
            relativeRoot: '/project',
        });
        // A diff tab still needs the overview: only it can turn the virtual URI into a filesystem path.
        expect(
            resolveDocumentTabPath(gitFileDiffTabPath('primary', 'src/index.ts'), {
                projectRoot: '/project',
            }),
        ).toBeUndefined();
    });
});

describe('documentTabDesktopActionState', () => {
    const unavailableReason = 'The file path is unavailable';

    it('hands an ordinary tab its absolute path', () => {
        expect(
            documentTabDesktopActionState(
                { absolutePath: '/project/page.html', relativeRoot: '/project' },
                { unavailableReason },
            ),
        ).toEqual({ target: { kind: 'path', path: '/project/page.html' } });
    });

    it('routes an external document through its opaque ID instead of its real path', () => {
        expect(
            documentTabDesktopActionState(
                { absolutePath: '/Users/me/Downloads/report.html' },
                { externalDocumentId: 'external-1', unavailableReason },
            ),
        ).toEqual({ target: { kind: 'external', documentId: 'external-1' } });
    });

    it('falls back to the supplied reason when no path resolved at all', () => {
        expect(documentTabDesktopActionState(undefined, { unavailableReason })).toEqual({
            disabledReason: unavailableReason,
        });
    });
});
