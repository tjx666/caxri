import { MAX_SOURCE_CONTROL_VIEW_STATE_ENTRIES } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    createSourceControlViewNavigation,
    serializeSourceControlViewNavigation,
    setSourceControlDirectoriesExpanded,
    updateSourceControlViewNavigation,
} from '../source-control-state';

describe('Source Control navigation state', () => {
    it('starts with generic empty disclosure and provider-mode state', () => {
        expect(createSourceControlViewNavigation()).toEqual({
            expandedDirectories: {},
            expandedGroups: {},
            expandedProviders: {},
        });
    });

    it('restores persisted navigation without mutating the Session snapshot', () => {
        const persisted = {
            expandedDirectories: { 'mode-a:provider-a:src': true },
            expandedGroups: { 'provider-a:group-a': false },
            expandedProviders: { 'provider-a': false },
            modeId: 'mode-a',
        };
        const restored = createSourceControlViewNavigation(persisted);
        const updated = updateSourceControlViewNavigation(restored, {
            expandedGroups: { ...restored.expandedGroups, 'provider-a:group-b': false },
        });

        expect(updated).toMatchObject({
            expandedGroups: {
                'provider-a:group-a': false,
                'provider-a:group-b': false,
            },
            modeId: 'mode-a',
        });
        expect(persisted.expandedGroups).toEqual({ 'provider-a:group-a': false });
    });

    it('bounds persisted disclosure entries while retaining the newest interactions', () => {
        const expandedDirectories = Object.fromEntries(
            Array.from({ length: MAX_SOURCE_CONTROL_VIEW_STATE_ENTRIES + 2 }, (_, index) => [
                `directory-${index}`,
                false,
            ]),
        );
        const serialized = serializeSourceControlViewNavigation({
            expandedDirectories,
            expandedGroups: {},
            expandedProviders: {},
        });

        expect(Object.keys(serialized.expandedDirectories)).toHaveLength(
            MAX_SOURCE_CONTROL_VIEW_STATE_ENTRIES,
        );
        expect(serialized.expandedDirectories).not.toHaveProperty('directory-0');
        expect(serialized.expandedDirectories).toHaveProperty(
            `directory-${MAX_SOURCE_CONTROL_VIEW_STATE_ENTRIES + 1}`,
            false,
        );
    });

    it('updates a directory subtree atomically without changing existing disclosure state', () => {
        const initial = { sibling: true, stale: false };

        const updated = setSourceControlDirectoriesExpanded(
            initial,
            ['root', 'root/nested'],
            false,
        );

        expect(updated).toEqual({
            'sibling': true,
            'stale': false,
            'root': false,
            'root/nested': false,
        });
        expect(initial).toEqual({ sibling: true, stale: false });
    });

    it('keeps the recursively toggled root when persistence reaches its safety limit', () => {
        const keys = [
            'root',
            ...Array.from(
                { length: MAX_SOURCE_CONTROL_VIEW_STATE_ENTRIES + 1 },
                (_, index) => `root/directory-${index}`,
            ),
        ];
        const expandedDirectories = setSourceControlDirectoriesExpanded({}, keys, false);

        const serialized = serializeSourceControlViewNavigation({
            expandedDirectories,
            expandedGroups: {},
            expandedProviders: {},
        });

        expect(serialized.expandedDirectories).toHaveProperty('root', false);
    });
});
