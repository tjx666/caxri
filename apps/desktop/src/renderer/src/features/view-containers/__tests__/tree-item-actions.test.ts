import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TreeItemAction } from '../tree-item-actions';
import { runTreeItemAction, treeItemActionKeyIntent } from '../tree-item-actions';

const mocks = vi.hoisted(() => ({
    dispatch: vi.fn(() => Promise.resolve('executed' as const)),
    showConfirm: vi.fn<() => Promise<boolean>>(),
}));

vi.mock('../../../lib/caxri', () => ({ caxri: { window: { showConfirm: mocks.showConfirm } } }));
vi.mock('../view-container-commands', () => ({ dispatchExtensionViewAction: mocks.dispatch }));

const action: TreeItemAction = {
    command: {
        id: 'caxri.project-status.mergePullRequest',
        title: 'Merge Pull Request',
        arguments: [{ number: 42 }],
    },
    icon: { kind: 'theme', id: 'git-merge' },
};

describe('runTreeItemAction', () => {
    beforeEach(() => {
        mocks.dispatch.mockClear();
        mocks.showConfirm.mockReset();
    });

    it('dispatches an unconfirmed action straight away', async () => {
        await runTreeItemAction(action);

        expect(mocks.showConfirm).not.toHaveBeenCalled();
        expect(mocks.dispatch).toHaveBeenCalledWith(
            'caxri.project-status.mergePullRequest',
            'Merge Pull Request',
            [{ number: 42 }],
        );
    });

    it('asks first and dispatches nothing when the user cancels', async () => {
        const confirmation = {
            title: 'Merge pull request #42?',
            message: 'Checks are still running.',
            confirmLabel: 'Merge',
        };
        mocks.showConfirm.mockResolvedValueOnce(false);
        await runTreeItemAction({ ...action, confirmation });

        expect(mocks.showConfirm).toHaveBeenCalledWith(confirmation);
        expect(mocks.dispatch).not.toHaveBeenCalled();

        mocks.showConfirm.mockResolvedValueOnce(true);
        await runTreeItemAction({ ...action, confirmation });
        expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    });
});

describe('treeItemActionKeyIntent', () => {
    it('walks the actions with Left and Right without wrapping', () => {
        expect(treeItemActionKeyIntent('ArrowRight', 0, 3)).toEqual({ kind: 'focus', index: 1 });
        expect(treeItemActionKeyIntent('ArrowLeft', 2, 3)).toEqual({ kind: 'focus', index: 1 });
        expect(treeItemActionKeyIntent('ArrowRight', 2, 3)).toEqual({ kind: 'none' });
    });

    it('returns to the row on Left from the first action and on Escape', () => {
        expect(treeItemActionKeyIntent('ArrowLeft', 0, 2)).toEqual({ kind: 'row' });
        expect(treeItemActionKeyIntent('Escape', 1, 2)).toEqual({ kind: 'row' });
    });

    it('leaves Enter and Space to the button and other keys to the row', () => {
        expect(treeItemActionKeyIntent('Enter', 0, 1)).toEqual({ kind: 'native' });
        expect(treeItemActionKeyIntent(' ', 0, 1)).toEqual({ kind: 'native' });
        expect(treeItemActionKeyIntent('ArrowDown', 0, 1)).toBeUndefined();
        expect(treeItemActionKeyIntent('Tab', 0, 1)).toBeUndefined();
    });
});
