import { describe, expect, it } from 'vitest';

import { externalEditorTabPath } from '../external-editor-tab';
import { filePreviewTabLabel, filePreviewTabPath, parseFilePreviewTab } from '../file-preview';

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
    });
});
