import type { SourceControlAction, SourceControlViewModel } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { findSourceControlActionByCommand } from '../source-control-action-resolution';

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
