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
            false,
        );
        expect(projected.actions).toEqual([merge, action('caxri.openExternal')]);
    });

    it('keeps send-to-Agent for a control device and drops Renderer-only commands', () => {
        const projected = projectMobileTreeItem(
            row([action('caxri.sendToAgent'), action('caxri.showLogs')]),
            isExtensionCommand,
            true,
        );
        expect(projected.actions).toEqual([action('caxri.sendToAgent')]);
    });

    it('drops the send-to-Agent action for a device that cannot start an Agent turn', () => {
        const projected = projectMobileTreeItem(
            row([action('caxri.sendToAgent')]),
            isExtensionCommand,
            false,
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
            false,
        );
        expect(projected.actions).toEqual([
            { command: { id: 'caxri.project-status.refresh', title: 'Refresh' } },
        ]);
    });
});
