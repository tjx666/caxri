import { describe, expect, it } from 'vitest';

import { externalEditorTabPath } from '../external-editor-tab';
import { filePreviewTabLabel, filePreviewTabPath, parseFilePreviewTab } from '../file-preview';
import {
    isPreviewImagePath,
    MAX_PREVIEW_ASSET_BYTES,
    MAX_PREVIEW_DOCUMENT_BYTES,
    previewAssetByteLimit,
    previewAssetMediaType,
} from '../preview-asset';

describe('file preview tabs', () => {
    it('round-trips a Project file and an external document source', () => {
        const external = externalEditorTabPath('doc-1', '接入说明.md');

        expect(parseFilePreviewTab(filePreviewTabPath('/p/README.md'))).toEqual({
            path: '/p/README.md',
        });
        expect(parseFilePreviewTab(filePreviewTabPath(external))).toEqual({ path: external });
    });

    it('rejects a source that is neither absolute nor an external document', () => {
        expect(parseFilePreviewTab(filePreviewTabPath('relative/README.md'))).toBeUndefined();
    });

    it('labels an external preview with the decoded file name', () => {
        expect(filePreviewTabLabel(externalEditorTabPath('doc-1', '接入说明.md'))).toBe(
            'Preview: 接入说明.md',
        );
        expect(filePreviewTabLabel('/p/README.md')).toBe('Preview: README.md');
        expect(filePreviewTabLabel('/p/manual.pdf', { isOnlyView: true })).toBe('manual.pdf');
    });
});

describe('preview asset media types', () => {
    it('admits a PDF under the document ceiling and images under the image ceiling', () => {
        expect(previewAssetMediaType('/p/docs/Manual.PDF')).toBe('application/pdf');
        expect(previewAssetByteLimit('application/pdf')).toBe(MAX_PREVIEW_DOCUMENT_BYTES);
        expect(previewAssetMediaType('/p/logo.png')).toBe('image/png');
        expect(previewAssetByteLimit('image/png')).toBe(MAX_PREVIEW_ASSET_BYTES);
    });

    it('refuses a text format the editor reads instead', () => {
        expect(previewAssetMediaType('/p/data.csv')).toBeUndefined();
    });

    it('lets a document embed images but not a PDF', () => {
        expect(isPreviewImagePath('/p/docs/diagram.SVG')).toBe(true);
        expect(isPreviewImagePath('/p/docs/manual.pdf')).toBe(false);
        expect(isPreviewImagePath('/p/docs/notes.txt')).toBe(false);
    });
});
