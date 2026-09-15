import { describe, expect, it } from 'vitest';

import { canPreviewPath, previewerForPath } from '../preview-registry';

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

    it('keeps source the default view for every format that is also readable as text', () => {
        for (const path of ['/p/README.md', '/p/logo.svg'])
            expect(previewerForPath(path)?.defaultView).toBe('source');
    });
});
