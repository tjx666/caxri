import type { TreeItemDto } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { projectMobileTreeItem } from '../panel-projection';

type TreeItemAction = NonNullable<TreeItemDto['actions']>[number];

const action = (id: string, extra: Partial<TreeItemAction> = {}): TreeItemAction => ({
    command: { id, title: id },
    icon: { kind: 'theme' as const, id: 'git-merge' },
    ...extra,
});

const row = (actions: TreeItemDto['actions']): TreeItemDto => ({
    handle: 'h1',
    label: 'lobehub',
    accessibilityLabel: 'lobehub',
    collapsibleState: 'none',
    actions,
});

const isExtensionCommand = (id: string) => id.startsWith('caxri.project-status.');

describe('projectMobileTreeItem', () => {
    it('keeps extension and link actions with their presentation', () => {
        const merge = action('caxri.project-status.mergePullRequest', {
            label: 'Merge',
            tone: 'success' as const,
            feedback: { failure: "Couldn't merge #1" },
        });
        const projected = projectMobileTreeItem(
            row([merge, action('caxri.openExternal')]),
            isExtensionCommand,
        );
        expect(projected.actions).toEqual([merge, action('caxri.openExternal')]);
    });

    it('drops Renderer-resolved commands a phone cannot run', () => {
        const projected = projectMobileTreeItem(
            row([action('caxri.sendToAgent'), action('caxri.showLogs')]),
            isExtensionCommand,
        );
        expect(projected).not.toHaveProperty('actions');
    });

    it('drops a resource icon but keeps the action', () => {
        const projected = projectMobileTreeItem(
            row([
                {
                    command: { id: 'caxri.project-status.refresh', title: 'Refresh' },
                    icon: { kind: 'resource', uri: 'data:image/png;base64,AA==' } as never,
                },
            ]),
            isExtensionCommand,
        );
        expect(projected.actions).toEqual([
            { command: { id: 'caxri.project-status.refresh', title: 'Refresh' } },
        ]);
    });
});
