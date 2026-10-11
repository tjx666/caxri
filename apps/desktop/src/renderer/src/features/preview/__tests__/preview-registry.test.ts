import { describe, expect, it } from 'vitest';

import { canPreviewPath, previewerForPath, shouldOpenAsPreview } from '../preview-registry';

describe('previewerForPath', () => {
    it('routes every registered Markdown extension to the Markdown view', () => {
        for (const path of ['/p/README.md', '/p/notes.markdown', '/p/guide.mdx'])
            expect(previewerForPath(path)?.id).toBe('markdown');
    });

    it('routes SVG to the image view', () => {
        expect(previewerForPath('/p/assets/logo.svg')?.id).toBe('image');
    });

    it('matches the extension without regard to case', () => {
        expect(previewerForPath('/p/README.MD')?.id).toBe('markdown');
    });

    it('leaves a file no previewer claims to the editor', () => {
        expect(previewerForPath('/p/src/index.ts')).toBeUndefined();
        expect(canPreviewPath('/p/src/index.ts')).toBe(false);
    });

    it('does not treat a dotfile name as an extension', () => {
        expect(previewerForPath('/p/.md')).toBeUndefined();
    });

    it('routes delimited text, Mermaid, and PDF files to their views', () => {
        expect(previewerForPath('/p/data/report.csv')?.id).toBe('table');
        expect(previewerForPath('/p/data/report.tsv')?.id).toBe('table');
        expect(previewerForPath('/p/docs/flow.mmd')?.id).toBe('mermaid');
        expect(previewerForPath('/p/docs/flow.mermaid')?.id).toBe('mermaid');
        expect(previewerForPath('/p/docs/manual.pdf')?.id).toBe('pdf');
    });

    it('keeps source the default view for every format that is also readable as text', () => {
        for (const path of ['/p/README.md', '/p/logo.svg', '/p/data.csv', '/p/flow.mmd']) {
            expect(previewerForPath(path)?.defaultView).toBe('source');
            expect(shouldOpenAsPreview(path)).toBe(false);
        }
    });

    it('opens a PDF straight into its preview because it has no text form', () => {
        expect(shouldOpenAsPreview('/p/docs/Manual.PDF')).toBe(true);
        expect(shouldOpenAsPreview('/p/src/index.ts')).toBe(false);
    });
});
