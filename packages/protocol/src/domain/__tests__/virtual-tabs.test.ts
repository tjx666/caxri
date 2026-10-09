import { describe, expect, it } from 'vitest';

import {
    externalEditorTabPath,
    isExternalEditorTabPath,
    parseExternalEditorTab,
} from '../external-editor-tab';
import { isVirtualEditorTabPath } from '../virtual-tabs';

describe('external editor virtual tabs', () => {
    it('round-trips an opaque document id and display name without embedding a filesystem path', () => {
        const path = externalEditorTabPath('document-1', 'doctor config.jsonc');

        expect(path).toBe('caxri-external-file://document-1/doctor%20config.jsonc');
        expect(parseExternalEditorTab(path)).toEqual({
            documentId: 'document-1',
            name: 'doctor config.jsonc',
        });
        expect(isExternalEditorTabPath(path)).toBe(true);
        expect(isVirtualEditorTabPath(path)).toBe(true);
    });

    it.each([
        'caxri-external-file://',
        'caxri-external-file://missing-name/',
        'caxri-external-file:///missing-id',
        'caxri-external-file://bad%ZZ/name.ts',
    ])('rejects malformed external editor paths: %s', (path) => {
        expect(parseExternalEditorTab(path)).toBeUndefined();
        expect(isExternalEditorTabPath(path)).toBe(false);
    });
});
