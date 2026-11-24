import { externalEditorTabPath, filePreviewTabPath } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/desktop-file-actions', () => ({
    openExternalDocumentWithDefaultApp: vi.fn(),
    openFileWithDefaultApp: vi.fn(),
}));

import { htmlPageTarget } from './commands';

describe('htmlPageTarget', () => {
    it('names a Project page from its source tab and its preview tab alike', () => {
        expect(htmlPageTarget('/repo/report.html')).toEqual({
            kind: 'project',
            path: '/repo/report.html',
        });
        expect(htmlPageTarget(filePreviewTabPath('/repo/report.HTM'))).toEqual({
            kind: 'project',
            path: '/repo/report.HTM',
        });
    });

    it('names an external page by its document ID', () => {
        expect(htmlPageTarget(externalEditorTabPath('document-1', 'daily report.html'))).toEqual({
            kind: 'external',
            documentId: 'document-1',
        });
        const externalTab = externalEditorTabPath('document-1', 'daily.html');
        expect(htmlPageTarget(filePreviewTabPath(externalTab))).toEqual({
            kind: 'external',
            documentId: 'document-1',
        });
    });

    it('ignores a tab that is not an HTML page', () => {
        expect(htmlPageTarget('/repo/notes.md')).toBeUndefined();
        expect(htmlPageTarget(filePreviewTabPath('/repo/notes.md'))).toBeUndefined();
    });
});
