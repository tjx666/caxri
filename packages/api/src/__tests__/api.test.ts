import { describe, expect, it } from 'vitest';

import caxri, {
    CancellationTokenSource,
    Disposable,
    EventEmitter,
    ThemeIcon,
    TreeItem,
    TreeItemCollapsibleState,
} from '../index.js';

describe('caxri public API runtime', () => {
    it('provides stable runtime classes without a Host', () => {
        const item = new TreeItem('Project', TreeItemCollapsibleState.Collapsed);
        item.iconPath = new ThemeIcon('folder');
        expect(item).toMatchObject({
            collapsibleState: TreeItemCollapsibleState.Collapsed,
            iconPath: { id: 'folder' },
            label: 'Project',
        });
    });

    it('disposes events and cancellation exactly once', () => {
        // eslint-disable-next-line unicorn/prefer-event-target -- Verify the VS Code-compatible EventEmitter behavior exposed by the public API.
        const emitter = new EventEmitter<number>();
        const values: number[] = [];
        const subscription = emitter.event((value) => values.push(value));
        emitter.fire(1);
        subscription.dispose();
        emitter.fire(2);

        const tokenSource = new CancellationTokenSource();
        let cancellations = 0;
        const cancellation = tokenSource.token.onCancellationRequested(() => cancellations++);
        tokenSource.cancel();
        Disposable.from(cancellation, tokenSource).dispose();

        expect(values).toEqual([1]);
        expect(tokenSource.token.isCancellationRequested).toBe(true);
        expect(cancellations).toBe(1);
    });

    it('fails clearly when the runtime stub is used outside the Extension Host', () => {
        expect(() => caxri.views.registerTreeDataProvider('example.view', {} as never)).toThrow(
            expect.objectContaining({ code: 'CAXRI_API_OUTSIDE_EXTENSION_HOST' }),
        );
        expect(() =>
            caxri.views.registerResourceExplorerProvider('example.files', {} as never),
        ).toThrow(expect.objectContaining({ code: 'CAXRI_API_OUTSIDE_EXTENSION_HOST' }));
        expect(() => caxri.views.registerSourceControlProvider('example.git', {} as never)).toThrow(
            expect.objectContaining({ code: 'CAXRI_API_OUTSIDE_EXTENSION_HOST' }),
        );
        expect(() => caxri.workspace.fs.list()).toThrow(
            expect.objectContaining({ code: 'CAXRI_API_OUTSIDE_EXTENSION_HOST' }),
        );
        expect(() => caxri.workspace.git.summary()).toThrow(
            expect.objectContaining({ code: 'CAXRI_API_OUTSIDE_EXTENSION_HOST' }),
        );
    });
});
