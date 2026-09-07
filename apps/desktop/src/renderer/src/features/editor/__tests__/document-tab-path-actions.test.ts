import {
    agentTranscriptTabPath,
    externalEditorTabPath,
    gitChangesDiffTabPath,
    gitCommitFileDiffTabPath,
    gitFileDiffTabPath,
} from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { resolveDocumentTabPath } from '../document-tab-path-actions';

const repositories = [
    { id: 'primary', rootPath: '/project' },
    { id: 'nested', rootPath: '/project/packages/nested' },
    { id: 'submodule', rootPath: '/project/vendor/sub' },
] as const;

describe('resolveDocumentTabPath', () => {
    it('keeps ordinary files absolute and uses the innermost repository for relative output', () => {
        expect(
            resolveDocumentTabPath('/project/vendor/sub/src/index.ts', {
                projectRoot: '/project',
                repositories,
            }),
        ).toEqual({
            absolutePath: '/project/vendor/sub/src/index.ts',
            relativeRoot: '/project/vendor/sub',
        });
    });

    it('resolves a single-file diff URI against its repository root', () => {
        expect(
            resolveDocumentTabPath(gitFileDiffTabPath('submodule', 'src/index.ts'), {
                projectRoot: '/project',
                repositories,
            }),
        ).toEqual({
            absolutePath: '/project/vendor/sub/src/index.ts',
            relativeRoot: '/project/vendor/sub',
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
            relativeRoot: '/project/packages/nested',
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

    it('falls back to the Project root for non-Git files and waits for repo data before relative diff output', () => {
        expect(
            resolveDocumentTabPath('/project/notes.txt', {
                projectRoot: '/project',
                repositories: [],
            }),
        ).toEqual({ absolutePath: '/project/notes.txt', relativeRoot: '/project' });
        expect(resolveDocumentTabPath('/project/notes.txt', { projectRoot: '/project' })).toEqual({
            absolutePath: '/project/notes.txt',
        });
        expect(
            resolveDocumentTabPath(gitFileDiffTabPath('primary', 'src/index.ts'), {
                projectRoot: '/project',
            }),
        ).toBeUndefined();
    });
});
