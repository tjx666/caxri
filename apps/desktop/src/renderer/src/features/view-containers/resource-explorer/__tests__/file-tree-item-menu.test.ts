import type { FileEntry } from '@caxri/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/caxri', () => ({ caxri: { request: vi.fn() } }));

import type { ContextMenuEntries } from '../../../../lib/context-menu';
import { serializeContextMenu } from '../../../../lib/context-menu';
import { useDialogStore } from '../../../../stores/dialogs';
import { useEnvironmentStore } from '../../../../stores/environment';
import { fileOperationBusyReason, pasteDisabledReason } from '../file-operation-state';
import type { FileTreeItemMenuOptions } from '../file-tree-item-menu';
import { fileTreeItemMenu } from '../file-tree-item-menu';
import { fileTreeRootMenu } from '../file-tree-root-context-menu';

function options(entry: FileEntry, overrides: Partial<FileTreeItemMenuOptions> = {}) {
    return {
        confirmTrash: vi.fn(async () => {}),
        duplicateBlocked: false,
        duplicateEntry: vi.fn(async () => {}),
        entry,
        openEntry: vi.fn(),
        parentDirectory: '/project',
        pasteDisabledReason: undefined,
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
    beforeEach(() => {
        useEnvironmentStore.setState({ state: { kind: 'local' } });
    });

    it('offers create entries only on a directory and default-app only on a file', () => {
        const directoryLabels = labels(fileTreeItemMenu(options(directory)));
        expect(directoryLabels).toEqual([
            'Open',
            'Reveal in Finder',
            'Open in Terminal',
            'Find in Folder…',
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
        expect(fileLabels).not.toContain('Find in Folder…');
    });

    it('drops the entries that hand the file to this Mac in an SSH Host window', () => {
        useEnvironmentStore.setState({
            state: {
                kind: 'ssh',
                destination: 'devbox',
                phase: 'connected',
                needsUserAction: false,
            },
        });
        const fileLabels = labels(fileTreeItemMenu(options(file)));
        expect(fileLabels).not.toContain('Open with Default App');
        expect(fileLabels).not.toContain('Reveal in Finder');
        expect(fileLabels).toContain('Open in Terminal');
        // Main moves the entry into the SSH Host's own Trash.
        expect(fileLabels.at(-1)).toBe('Move to Trash');
    });

    it('opens Project search scoped to the directory while keeping the previous query', () => {
        const findInFolder = fileTreeItemMenu(
            options({ kind: 'directory', name: 'b', path: '/project/src/b' }),
        ).find((entry) => entry && 'label' in entry && entry.label === 'Find in Folder…');
        if (!findInFolder || !('onSelect' in findInFolder))
            throw new Error('Find in Folder is missing');
        useDialogStore.getState().setProjectSearchOpen(false);
        const previousId = useDialogStore.getState().projectSearchSeedRequest.id;

        findInFolder.onSelect();

        const state = useDialogStore.getState();
        expect(state.projectSearchOpen).toBe(true);
        expect(state.projectSearchSeedRequest).toEqual({
            id: previousId + 1,
            seed: { include: 'src/b/**' },
        });
    });

    it('keeps Paste and Duplicate visible but disabled with their reasons, without a shortcut hint for a Paste that cannot run', () => {
        const { items } = serializeContextMenu(
            fileTreeItemMenu(
                options(file, { pasteDisabledReason: 'Nothing to paste', duplicateBlocked: true }),
            ),
        );
        const paste = items.find((item) => item.label === 'Paste');
        expect(paste).toMatchObject({ enabled: false, disabledReason: 'Nothing to paste' });
        expect(paste?.shortcut).toBeUndefined();
        expect(items.find((item) => item.label === 'Duplicate')).toMatchObject({
            enabled: false,
            disabledReason: fileOperationBusyReason(),
        });
    });

    it('offers an enabled Paste with its shortcut and no reason', () => {
        const { items } = serializeContextMenu(fileTreeItemMenu(options(file)));
        const paste = items.find((item) => item.label === 'Paste');
        expect(paste).toMatchObject({ shortcut: 'cmd+v' });
        expect(paste).not.toHaveProperty('enabled');
        expect(paste).not.toHaveProperty('disabledReason');
        expect(items.find((item) => item.label === 'Duplicate')).not.toHaveProperty(
            'disabledReason',
        );
    });

    it('starts the inline rename from the Rename entry', () => {
        const menu = options(file);
        const { items, actions } = serializeContextMenu(fileTreeItemMenu(menu));
        const rename = items.find((item) => item.label === 'Rename');
        actions.get(rename!.id!)?.();
        expect(menu.startRename).toHaveBeenCalledOnce();
    });
});

describe('pasteDisabledReason', () => {
    it('explains an empty clipboard before a busy target, and nothing while Paste can run', () => {
        expect(pasteDisabledReason({ isBlocked: true, isClipboardEmpty: true })).toBe(
            'Nothing to paste',
        );
        expect(pasteDisabledReason({ isBlocked: true, isClipboardEmpty: false })).toBe(
            fileOperationBusyReason(),
        );
        expect(pasteDisabledReason({ isBlocked: false, isClipboardEmpty: false })).toBeUndefined();
    });
});

describe('fileTreeRootMenu', () => {
    it('explains a disabled background Paste', () => {
        const { items } = serializeContextMenu(
            fileTreeRootMenu({
                createRootFile: vi.fn(),
                createRootFolder: vi.fn(),
                isRootPasteBlocked: false,
                isRootPasteEmpty: true,
                pasteIntoProjectRoot: vi.fn(),
            }),
        );
        expect(items.find((item) => item.label === 'Paste')).toMatchObject({
            enabled: false,
            disabledReason: 'Nothing to paste',
        });
    });
});
