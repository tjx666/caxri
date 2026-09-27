import type { FileEntry } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/caxri', () => ({ caxri: { request: vi.fn() } }));

import type { ContextMenuEntries } from '../../../../lib/context-menu';
import { serializeContextMenu } from '../../../../lib/context-menu';
import type { FileTreeItemMenuOptions } from '../file-tree-item-menu';
import { fileTreeItemMenu } from '../file-tree-item-menu';

function options(entry: FileEntry, overrides: Partial<FileTreeItemMenuOptions> = {}) {
    return {
        confirmTrash: vi.fn(async () => {}),
        duplicateBlocked: false,
        duplicateEntry: vi.fn(async () => {}),
        entry,
        openEntry: vi.fn(),
        parentDirectory: '/project',
        pasteDisabled: false,
        pasteIntoEntry: vi.fn(async () => {}),
        projectId: 'project-1',
        projectRoot: '/project',
        startCreate: vi.fn(),
        startRename: vi.fn(),
        ...overrides,
    } satisfies FileTreeItemMenuOptions;
}

function labels(entries: ContextMenuEntries): string[] {
    return serializeContextMenu(entries).items.map((item) =>
        item.type === 'separator'
            ? '---'
            : `${item.label}${item.enabled === false ? ' (disabled)' : ''}`,
    );
}

const directory: FileEntry = { kind: 'directory', name: 'src', path: '/project/src' };
const file: FileEntry = { kind: 'file', name: 'notes.txt', path: '/project/notes.txt' };

describe('fileTreeItemMenu', () => {
    it('offers create entries only on a directory and default-app only on a file', () => {
        const directoryLabels = labels(fileTreeItemMenu(options(directory)));
        expect(directoryLabels).toEqual([
            'Open',
            'Reveal in Finder',
            'Open in Terminal',
            '---',
            'Cut',
            'Copy',
            'Paste',
            'Duplicate',
            'Copy Path',
            'Copy Relative Path',
            '---',
            'New File',
            'New Folder',
            'Rename',
            '---',
            'Move to Trash',
        ]);
        const fileLabels = labels(fileTreeItemMenu(options(file)));
        expect(fileLabels).toContain('Open with Default App');
        expect(fileLabels).not.toContain('New File');
    });

    it('keeps Paste and Duplicate visible but disabled, without a shortcut hint for a Paste that cannot run', () => {
        const { items } = serializeContextMenu(
            fileTreeItemMenu(options(file, { pasteDisabled: true, duplicateBlocked: true })),
        );
        const paste = items.find((item) => item.label === 'Paste');
        expect(paste?.enabled).toBe(false);
        expect(paste?.shortcut).toBeUndefined();
        expect(items.find((item) => item.label === 'Duplicate')?.enabled).toBe(false);
    });

    it('starts the inline rename from the Rename entry', () => {
        const menu = options(file);
        const { items, actions } = serializeContextMenu(fileTreeItemMenu(menu));
        const rename = items.find((item) => item.label === 'Rename');
        actions.get(rename!.id!)?.();
        expect(menu.startRename).toHaveBeenCalledOnce();
    });
});
