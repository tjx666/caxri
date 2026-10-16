import type { PaneLayout } from '@caxri/protocol';
import { filePreviewTabPath } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    canPreviewPath,
    previewerForPath,
    previewOnlyTabPath,
    shouldOpenAsPreview,
} from '../preview-registry';

describe('previewerForPath', () => {
    it('routes every registered Markdown extension to the Markdown view', () => {
        for (const path of ['/p/README.md', '/p/notes.markdown', '/p/guide.mdx'])
            expect(previewerForPath(path)?.id).toBe('markdown');
    });

    it('opens raster images through the existing image preview without a text read', () => {
        for (const extension of [
            'apng',
            'avif',
            'png',
            'PNG',
            'jpg',
            'jpeg',
            'gif',
            'webp',
            'bmp',
            'ico',
        ]) {
            const path = `/p/assets/example.${extension}`;
            expect(previewerForPath(path)?.id).toBe('image');
            expect(shouldOpenAsPreview(path)).toBe(true);
            expect(previewOnlyTabPath(path, undefined)).toBe(filePreviewTabPath(path));
        }
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

describe('previewOnlyTabPath', () => {
    const layoutWith = (...paths: string[]): PaneLayout => ({
        root: {
            type: 'pane',
            id: 'pane-1',
            tabs: paths.map((path, index) => ({
                id: `tab-${index}`,
                resource: { kind: 'file', path },
            })),
            activeTabId: 'tab-0',
        },
        activePaneId: 'pane-1',
    });

    it('opens a format with no text form straight into its preview', () => {
        expect(previewOnlyTabPath('/p/manual.pdf', undefined)).toBe(
            filePreviewTabPath('/p/manual.pdf'),
        );
    });

    it('reuses the no-preview tab an earlier binary read opened', () => {
        const layout = layoutWith(filePreviewTabPath('/p/sample.bin'));
        expect(previewOnlyTabPath('/p/sample.bin', layout)).toBe(
            filePreviewTabPath('/p/sample.bin'),
        );
        expect(previewOnlyTabPath('/p/other.bin', layout)).toBeUndefined();
    });

    it('reads a text-backed format as source even when its preview is open', () => {
        const layout = layoutWith(filePreviewTabPath('/p/README.md'));
        expect(previewOnlyTabPath('/p/README.md', layout)).toBeUndefined();
    });
});
