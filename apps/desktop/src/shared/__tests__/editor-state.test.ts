import { describe, expect, it } from 'vitest';

import { editorModelPath, replaceWithExternalDocument, setSessionDocument } from '../editor-state';

describe('external editor changes', () => {
    it('always replaces a dirty buffer with disk state', () => {
        const result = replaceWithExternalDocument({
            path: '/project/file.ts',
            content: 'external',
            mtimeMs: 2,
            size: 8,
        });
        expect(result).toEqual({
            path: '/project/file.ts',
            content: 'external',
            mtimeMs: 2,
            size: 8,
            dirty: false,
        });
    });
});

describe('Session document cache', () => {
    it('stores buffers independently when Sessions share the same root path', () => {
        const first = setSessionDocument({}, 'session-1', {
            path: '/project/file.ts',
            content: 'session one',
            dirty: true,
            mtimeMs: 1,
            size: 11,
        });
        const second = setSessionDocument(first, 'session-2', {
            path: '/project/file.ts',
            content: 'disk state',
            dirty: false,
            mtimeMs: 2,
            size: 10,
        });

        expect(second['session-1']['/project/file.ts'].content).toBe('session one');
        expect(second['session-2']['/project/file.ts'].content).toBe('disk state');
        expect(editorModelPath('session-1', '/project/file.ts')).not.toBe(
            editorModelPath('session-2', '/project/file.ts'),
        );
    });

    it('escapes URI delimiters in Monaco model paths without collapsing filesystem segments', () => {
        const modelPath = editorModelPath('session/1', '/project/a#b?c%2F.ts');

        expect(modelPath).toBe('caxri://session/session%2F1/project/a%23b%3Fc%252F.ts');
        expect(modelPath).not.toBe(editorModelPath('session/1', '/project/a/b.ts'));
    });

    it('maps an external virtual tab to a clean opaque Monaco source path', () => {
        expect(
            editorModelPath('session-1', 'caxri-external-file://document-1/external-only.ts'),
        ).toBe('caxri://session/session-1/external/document-1/external-only.ts');
    });
});
