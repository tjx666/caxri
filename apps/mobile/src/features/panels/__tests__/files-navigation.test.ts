import type { FileEntry } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { FilesNavigation } from '../files-navigation';
import {
    closePreview,
    editDraft,
    EMPTY_FILES_NAVIGATION,
    isDraftDirty,
    startDraft,
    stepBack,
} from '../files-navigation';

const entry = (name: string): FileEntry => ({ name, path: `/p/${name}` }) as FileEntry;

const editing = (): FilesNavigation =>
    startDraft(
        { draft: null, preview: entry('a.ts'), stack: [entry('src'), entry('lib')] },
        { content: 'one', contentHash: 'h1' },
    );

describe('files navigation', () => {
    it('records the base hash and original text when an edit starts', () => {
        expect(editing().draft).toEqual({ baseHash: 'h1', content: 'one', original: 'one' });
    });

    it('treats an untouched editor as clean and a typed change as dirty', () => {
        const typed = editDraft(editing(), 'two');
        const retyped = editDraft(editing(), 'one');
        expect(isDraftDirty(editing().draft)).toBe(false);
        expect(isDraftDirty(typed.draft)).toBe(true);
        expect(isDraftDirty(retyped.draft)).toBe(false);
    });

    it('walks Back from a clean editor to the preview, then each folder, then leaves', () => {
        const first = stepBack(editing());
        expect(first.kind).toBe('move');
        const preview = (first as { next: FilesNavigation }).next;
        expect(preview.draft).toBeNull();
        expect(preview.preview?.name).toBe('a.ts');
        const folder = (stepBack(preview) as { next: FilesNavigation }).next;
        expect(folder.preview).toBeNull();
        expect(folder.stack.map((item) => item.name)).toEqual(['src', 'lib']);
        const parent = (stepBack(folder) as { next: FilesNavigation }).next;
        expect(parent.stack.map((item) => item.name)).toEqual(['src']);
        const root = (stepBack(parent) as { next: FilesNavigation }).next;
        expect(root).toBe(EMPTY_FILES_NAVIGATION);
        expect(stepBack(root)).toEqual({ kind: 'unhandled' });
    });

    it('asks before Back drops a dirty draft', () => {
        const typed = editDraft(editing(), 'two');
        expect(stepBack(typed)).toEqual({ kind: 'confirm-discard' });
    });

    it('closes the preview to a breadcrumb depth and drops the draft', () => {
        const next = closePreview(editDraft(editing(), 'two'), 1);
        expect(next.preview).toBeNull();
        expect(next.draft).toBeNull();
        expect(next.stack.map((item) => item.name)).toEqual(['src']);
    });
});
