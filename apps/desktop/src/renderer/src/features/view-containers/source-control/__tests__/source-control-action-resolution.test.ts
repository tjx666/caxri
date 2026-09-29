import type { SourceControlAction, SourceControlViewModel } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
    findSourceControlActionByCommand,
    runSourceControlActionAgainstLatest,
    SUPERSEDED,
} from '../source-control-action-resolution';

function action(id: string, command: SourceControlAction['command'], isDisabled?: boolean) {
    return {
        id,
        label: id,
        icon: { kind: 'theme', id: 'circle' },
        command,
        ...(isDisabled && { disabled: isDisabled }),
    } satisfies SourceControlAction;
}

function model(revision: string, groupActions: SourceControlAction[]): SourceControlViewModel {
    return {
        accessibilityLabel: 'Git repositories',
        modeAccessibilityLabel: 'Source control mode',
        modes: [],
        refreshAction: action(`refresh-${revision}`, { id: 'caxri.git.refresh' }),
        revision,
        selectedModeId: 'working',
        title: 'Source Control',
        providers: [
            {
                id: 'repo-1',
                label: 'project',
                icon: { kind: 'theme', id: 'repo' },
                tooltip: 'project',
                description: 'main',
                descriptionKind: 'branch',
                descriptionAccessibilityLabel: 'main',
                descriptionTooltip: 'main',
                countLabel: '1',
                expandedByDefault: true,
                actions: [],
                groups: [
                    {
                        id: 'changes',
                        label: 'Changes',
                        count: 1,
                        expandedByDefault: true,
                        emptyMessage: 'No changes.',
                        actions: groupActions,
                        resources: [
                            {
                                id: 'tracked',
                                label: 'tracked.txt',
                                tooltip: 'tracked.txt',
                                accessibilityLabel: 'tracked.txt',
                                icon: { kind: 'theme', id: 'file' },
                                path: 'tracked.txt',
                                actions: [
                                    action(`stage-${revision}`, {
                                        id: 'caxri.git.stage',
                                        arguments: ['repo-1', ['tracked.txt']],
                                    }),
                                ],
                            },
                        ],
                    },
                ],
            },
        ],
    };
}

describe('findSourceControlActionByCommand', () => {
    it('re-resolves a revision-bound action by its command binding in a newer model', () => {
        const discard = { id: 'caxri.git.discardAll', arguments: ['repo-1'] };
        const fresh = model('2', [action('action-9', discard)]);

        expect(findSourceControlActionByCommand(fresh, discard)?.id).toBe('action-9');
        expect(
            findSourceControlActionByCommand(fresh, {
                id: 'caxri.git.stage',
                arguments: ['repo-1', ['tracked.txt']],
            })?.id,
        ).toBe('stage-2');
        expect(findSourceControlActionByCommand(fresh, { id: 'caxri.git.refresh' })?.id).toBe(
            'refresh-2',
        );
    });

    it('drops the intent when the binding vanished, changed target, or became disabled', () => {
        const discard = { id: 'caxri.git.discardAll', arguments: ['repo-1'] };

        const retargeted = action('action-9', {
            id: 'caxri.git.discardAll',
            arguments: ['repo-2'],
        });
        const disabled = action('action-9', discard, true);

        expect(findSourceControlActionByCommand(model('2', []), discard)).toBeUndefined();
        expect(findSourceControlActionByCommand(model('2', [retargeted]), discard)).toBeUndefined();
        expect(findSourceControlActionByCommand(model('2', [disabled]), discard)).toBeUndefined();
    });
});

describe('runSourceControlActionAgainstLatest', () => {
    const discard = { id: 'caxri.git.discardAll', arguments: ['repo-1'] };
    const stale = model('1', [action('action-1', discard)]);
    const fresh = model('2', [action('action-2', discard)]);

    it('runs the clicked action directly when no refresh is in flight', async () => {
        const refetch = vi.fn<() => Promise<SourceControlViewModel>>();
        const run = vi.fn(() => Promise.resolve('ran'));

        await expect(
            runSourceControlActionAgainstLatest({
                action: stale.providers[0].groups[0].actions[0],
                isRefreshing: false,
                model: stale,
                refetch,
                run,
            }),
        ).resolves.toEqual({ result: 'ran', revision: '1' });
        expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: 'action-1' }), '1');
        expect(refetch).not.toHaveBeenCalled();
    });

    it('waits for an in-flight refresh and runs the same command against the model it produced', async () => {
        const run = vi.fn(() => Promise.resolve('ran'));

        await expect(
            runSourceControlActionAgainstLatest({
                action: stale.providers[0].groups[0].actions[0],
                isRefreshing: true,
                model: stale,
                refetch: () => Promise.resolve(fresh),
                run,
            }),
        ).resolves.toEqual({ result: 'ran', revision: '2' });
        expect(run).toHaveBeenCalledOnce();
        expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: 'action-2' }), '2');
    });

    it('replays a superseded action against the refreshed model', async () => {
        const run = vi
            .fn<
                (
                    target: SourceControlAction,
                    revision: string,
                ) => Promise<string | typeof SUPERSEDED>
            >()
            .mockResolvedValueOnce(SUPERSEDED)
            .mockResolvedValueOnce('ran');

        await expect(
            runSourceControlActionAgainstLatest({
                action: stale.providers[0].groups[0].actions[0],
                isRefreshing: false,
                model: stale,
                refetch: () => Promise.resolve(fresh),
                run,
            }),
        ).resolves.toEqual({ result: 'ran', revision: '2' });
        expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'action-2' }), '2');
    });

    it('gives up when the command vanished or refreshes keep winning', async () => {
        const run = vi.fn(() => Promise.resolve(SUPERSEDED));

        await expect(
            runSourceControlActionAgainstLatest({
                action: stale.providers[0].groups[0].actions[0],
                isRefreshing: true,
                model: stale,
                refetch: () => Promise.resolve(model('2', [])),
                run,
            }),
        ).resolves.toBe(SUPERSEDED);
        expect(run).not.toHaveBeenCalled();

        await expect(
            runSourceControlActionAgainstLatest({
                action: stale.providers[0].groups[0].actions[0],
                isRefreshing: false,
                model: stale,
                refetch: () => Promise.resolve(fresh),
                run,
            }),
        ).resolves.toBe(SUPERSEDED);
        expect(run).toHaveBeenCalledTimes(3);
    });
});
