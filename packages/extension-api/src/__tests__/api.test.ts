import { describe, expect, it, vi } from 'vitest';

import caxri, {
    CancellationTokenSource,
    Disposable,
    EventEmitter,
    isGlobMatch,
    ProjectStatusSummaryErrorMessage,
    ThemeIcon,
    TreeItem,
    TreeItemCollapsibleState,
} from '../index.js';

describe('caxri public API runtime', () => {
    it('provides stable runtime classes without a Host', () => {
        const item = new TreeItem('Project', TreeItemCollapsibleState.Collapsed);
        item.iconPath = new ThemeIcon('folder');
        item.variant = 'header';
        item.tooltip = {
            kind: 'rich',
            title: 'preview',
            badge: { label: 'success', tone: 'success' },
            rows: [{ label: 'alias', value: 'preview.example.com', url: 'https://example.com' }],
        };
        expect(item).toMatchObject({
            collapsibleState: TreeItemCollapsibleState.Collapsed,
            iconPath: { id: 'folder' },
            label: 'Project',
            tooltip: { kind: 'rich', title: 'preview' },
            variant: 'header',
        });

        const message = new TreeItem('No Git repository');
        message.variant = 'message';
        expect(message).toMatchObject({
            collapsibleState: TreeItemCollapsibleState.None,
            label: 'No Git repository',
            variant: 'message',
        });
        expect(ProjectStatusSummaryErrorMessage).toEqual({
            missingGitRepository: 'The Project root is not a Git repository.',
            missingPrimaryRepository: 'No primary repository found.',
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

    it('delivers an event to a later listener when an earlier one throws', () => {
        // eslint-disable-next-line unicorn/prefer-event-target -- Verify the VS Code-compatible EventEmitter behavior exposed by the public API.
        const emitter = new EventEmitter<number>();
        const failing = vi.fn(() => {
            throw new Error('extension listener failure');
        });
        const surviving = vi.fn();
        emitter.event(failing);
        emitter.event(surviving);

        emitter.fire(1);

        expect(failing).toHaveBeenCalledTimes(1);
        expect(surviving).toHaveBeenCalledExactlyOnceWith(1);
    });

    it('disposes every combined entry before rethrowing the first teardown failure', () => {
        const firstFailure = new Error('extension teardown failure');
        const first = new Disposable(() => {
            throw firstFailure;
        });
        const second = new Disposable(() => {
            throw new Error('second teardown failure');
        });
        const survivingTeardown = vi.fn();
        const combined = Disposable.from(first, second, new Disposable(survivingTeardown));

        expect(() => combined.dispose()).toThrow(firstFailure);
        expect(survivingTeardown).toHaveBeenCalledTimes(1);
    });

    it('fails clearly when the runtime stub is used outside the Extension Host', () => {
        expect(() => isGlobMatch('example.test.ts', { '**/*.test.*': true })).toThrow(
            expect.objectContaining({ code: 'CAXRI_API_OUTSIDE_EXTENSION_HOST' }),
        );
        expect(() => caxri.views.registerTreeDataProvider('example.view', {} as never)).toThrow(
            expect.objectContaining({ code: 'CAXRI_API_OUTSIDE_EXTENSION_HOST' }),
        );
        expect(() => caxri.views.registerSourceControlProvider('example.git', {} as never)).toThrow(
            expect.objectContaining({ code: 'CAXRI_API_OUTSIDE_EXTENSION_HOST' }),
        );
        expect(() => caxri.workspace.git.summary()).toThrow(
            expect.objectContaining({ code: 'CAXRI_API_OUTSIDE_EXTENSION_HOST' }),
        );
        expect(() => caxri.workspace.getConfiguration('example.setting')).toThrow(
            expect.objectContaining({ code: 'CAXRI_API_OUTSIDE_EXTENSION_HOST' }),
        );
        expect(() => caxri.workspace.getCurrentContext()).toThrow(
            expect.objectContaining({ code: 'CAXRI_API_OUTSIDE_EXTENSION_HOST' }),
        );
    });
});
