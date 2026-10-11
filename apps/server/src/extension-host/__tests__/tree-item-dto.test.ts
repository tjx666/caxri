import { ThemeIcon, TreeItem } from 'caxri';
import { describe, expect, it } from 'vitest';

import { serializeTreeItem } from '../tree-item-dto';

describe('serializeTreeItem', () => {
    it('carries inline actions with their label, tone, and confirmation across the Host boundary', () => {
        const item = new TreeItem('#42 Delivery');
        item.actions = [
            {
                command: {
                    command: 'caxri.project-status.mergePullRequest',
                    title: 'Merge Pull Request',
                    arguments: [{ number: 42 }],
                },
                icon: new ThemeIcon('git-merge'),
                label: 'Checks running',
                tone: 'warning',
                confirmation: {
                    title: 'Merge pull request #42?',
                    message: 'Checks are still running.',
                    confirmLabel: 'Merge',
                },
            },
        ];

        expect(serializeTreeItem('handle-1', item).actions).toEqual([
            {
                command: {
                    id: 'caxri.project-status.mergePullRequest',
                    title: 'Merge Pull Request',
                    arguments: [{ number: 42 }],
                },
                icon: { kind: 'theme', id: 'git-merge' },
                label: 'Checks running',
                tone: 'warning',
                confirmation: {
                    title: 'Merge pull request #42?',
                    message: 'Checks are still running.',
                    confirmLabel: 'Merge',
                },
            },
        ]);
    });

    it('omits an empty action list and rejects more actions than a row can show', () => {
        const item = new TreeItem('Row');
        item.actions = [];
        expect(serializeTreeItem('handle-1', item)).not.toHaveProperty('actions');

        // A tone only colors a label, so an icon-only action drops it.
        item.actions = [
            {
                command: { command: 'caxri.example.run', title: 'Run' },
                icon: new ThemeIcon('check'),
                tone: 'danger',
            },
        ];
        expect(serializeTreeItem('handle-1', item).actions?.[0]).not.toHaveProperty('tone');

        const action = {
            command: { command: 'caxri.example.run', title: 'Run' },
            icon: new ThemeIcon('check'),
        };
        item.actions = [action, action, action, action];
        expect(() => serializeTreeItem('handle-1', item)).toThrow();
    });
});
