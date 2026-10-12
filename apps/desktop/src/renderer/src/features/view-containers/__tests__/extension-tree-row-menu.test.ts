import type { TreeItemDto } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/caxri', () => ({ caxri: { request: vi.fn() } }));

import type { ContextMenuEntries } from '../../../lib/context-menu';
import { serializeContextMenu } from '../../../lib/context-menu';
import { extensionTreeRowMenu, hasExtensionTreeRowMenu } from '../extension-tree-row-menu';
import type { TreeItemAction } from '../tree-item-actions';

const merge: TreeItemAction = {
    command: { id: 'fixture.merge', title: 'Merge Pull Request', arguments: [7] },
    confirmation: { title: 'Merge?', message: 'Merge #7.', confirmLabel: 'Merge' },
    icon: { kind: 'theme', id: 'git-merge' },
    label: 'Merge',
};
const openOnGitHub: TreeItemAction = {
    command: { id: 'caxri.openExternal', title: 'Open on GitHub', arguments: ['https://x.test'] },
    icon: { kind: 'theme', id: 'link-external' },
};

function item(overrides: Partial<TreeItemDto> = {}): TreeItemDto {
    return {
        accessibilityLabel: 'Pull request #7',
        collapsibleState: 'none',
        handle: 'row-7',
        label: 'Pull request #7',
        ...overrides,
    };
}

function labels(entries: ContextMenuEntries): string[] {
    return serializeContextMenu(entries).items.map((entry) =>
        entry.type === 'separator' ? '---' : (entry.label ?? ''),
    );
}

function runner(runningCommandIds: ReadonlySet<string> = new Set()) {
    return { activate: vi.fn(), runAction: vi.fn(), runningCommandIds };
}

function menuLabels(row: TreeItemDto): string[] {
    return labels(extensionTreeRowMenu(row, runner()));
}

function menuOf(row: TreeItemDto) {
    const run = runner();
    const serialized = serializeContextMenu(extensionTreeRowMenu(row, run));
    const choose = (label: string): void => {
        const entry = serialized.items.find(
            (candidate) => candidate.type === 'item' && candidate.label === label,
        );
        if (entry?.type !== 'item' || entry.id === undefined) throw new Error(`No ${label} entry`);
        serialized.actions.get(entry.id)?.();
    };
    return { choose, run };
}

describe('extensionTreeRowMenu', () => {
    it("lists the row's own command first, then the inline actions in button order", () => {
        const row = item({
            actions: [merge, openOnGitHub],
            command: { id: 'caxri.openExternal', title: 'Open Pull request #7' },
        });

        expect(menuLabels(row)).toEqual([
            'Open Pull request #7',
            '---',
            'Merge Pull Request',
            'Open on GitHub',
        ]);
    });

    it('runs what the matching click would run', () => {
        const row = item({
            actions: [merge, openOnGitHub],
            command: { id: 'caxri.openExternal', title: 'Open Pull request #7' },
        });
        const { choose, run } = menuOf(row);

        choose('Open Pull request #7');
        expect(run.activate).toHaveBeenCalledOnce();

        // The whole action travels, so its confirmation and feedback apply exactly as on the inline button.
        choose('Merge Pull Request');
        expect(run.runAction).toHaveBeenCalledExactlyOnceWith(merge);
    });

    it('disables an action the row is already running, as its busy button is', () => {
        const row = item({ actions: [merge, openOnGitHub] });
        const running = runner(new Set([merge.command.id]));
        const { items } = serializeContextMenu(extensionTreeRowMenu(row, running));
        const availability = items.map((entry) =>
            entry.type === 'item' ? [entry.label, entry.enabled] : [],
        );

        expect(availability).toEqual([
            ['Merge Pull Request', false],
            ['Open on GitHub', undefined],
        ]);
    });

    it('leaves out the separator when only one group exists', () => {
        const actionsOnly = item({ actions: [merge] });
        const commandOnly = item({ command: { id: 'fixture.open', title: 'Open' } });

        expect(menuLabels(actionsOnly)).toEqual(['Merge Pull Request']);
        expect(menuLabels(commandOnly)).toEqual(['Open']);
    });

    it('opens no menu for a row with nothing to run, or for a message row', () => {
        const plain = item({ collapsibleState: 'collapsed' });
        const message = item({
            command: { id: 'fixture.signIn', title: 'Sign In' },
            variant: 'message',
        });

        expect(hasExtensionTreeRowMenu(plain)).toBe(false);
        expect(hasExtensionTreeRowMenu(message)).toBe(false);
        expect(extensionTreeRowMenu(message, runner())).toEqual([]);
        expect(hasExtensionTreeRowMenu(item({ actions: [openOnGitHub] }))).toBe(true);
    });
});
