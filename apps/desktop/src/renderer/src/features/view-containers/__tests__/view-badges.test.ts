import type { ViewCatalogSnapshot } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { aggregateContainerBadges, badgeViews } from '../view-badges';

describe('view badges', () => {
    /**
     * The counts of the lesser kinds are deliberately dropped from the digit: a container holding 2 ordinary changes
     * and 9 failures used to show `11` in the failure color, which reads as 11 failures. Their descriptions stay.
     */
    it('tallies only the most severe kind in a container and keeps every description', () => {
        expect(
            aggregateContainerBadges([
                {
                    containerId: 'git',
                    badge: { kind: 'count', count: 120, description: '120 changes' },
                },
                {
                    containerId: 'status',
                    badge: { kind: 'count', count: 2, description: '2 changes' },
                },
                {
                    containerId: 'status',
                    badge: { kind: 'error', count: 9, description: '9 failures' },
                },
                {
                    containerId: 'status',
                    badge: { kind: 'warning', count: 4, description: '4 warnings' },
                },
                { containerId: 'empty', badge: null },
                {
                    containerId: 'zero',
                    badge: { kind: 'count', count: 0, description: 'No changes' },
                },
            ]),
        ).toEqual({
            git: { text: '99+', description: '120 changes', kind: 'count' },
            status: {
                text: '9',
                description: '2 changes, 9 failures, 4 warnings',
                kind: 'error',
            },
        });
    });

    it('shows a severity with no tally as an icon-only badge instead of an incomplete total', () => {
        expect(
            aggregateContainerBadges([
                { containerId: 'status', badge: { kind: 'error', description: 'Pipeline failed' } },
                {
                    containerId: 'status',
                    badge: { kind: 'error', count: 3, description: '3 jobs' },
                },
                {
                    containerId: 'other',
                    badge: { kind: 'warning', description: 'Stale deployment' },
                },
            ]),
        ).toEqual({
            status: { text: '', description: 'Pipeline failed, 3 jobs', kind: 'error' },
            other: { text: '', description: 'Stale deployment', kind: 'warning' },
        });
    });

    it.each(['discovered', 'activating', 'active', 'error', 'crashed', 'disabled'] as const)(
        'allows initial activation and gates unavailable providers: %s',
        (lifecycle) => {
            const catalog: ViewCatalogSnapshot = {
                revision: 1,
                commands: [],
                extensions: [{ id: 'fixture', version: '1', generation: 2, lifecycle }],
                containers: [
                    {
                        id: 'fixture',
                        location: 'secondarySidebar',
                        source: { kind: 'extension', extensionId: 'fixture' },
                        title: 'Fixture',
                        icon: { kind: 'builtin', id: 'info' },
                        commandId: 'fixture.show',
                        lifecycle,
                    },
                ],
                views: [
                    {
                        id: 'fixture.view',
                        containerId: 'fixture',
                        source: { kind: 'extension', extensionId: 'fixture' },
                        title: 'Fixture',
                        viewKind: { kind: 'tree' },
                        badge: true,
                    },
                ],
            };
            const expected = ['discovered', 'activating', 'active'].includes(lifecycle)
                ? [{ viewId: 'fixture.view', containerId: 'fixture', generation: 2 }]
                : [];
            expect(badgeViews(catalog, 'secondarySidebar')).toEqual(expected);
            expect(badgeViews(catalog, 'panel')).toEqual([]);
            expect(
                badgeViews(
                    { ...catalog, views: [{ ...catalog.views[0], badge: undefined }] },
                    'secondarySidebar',
                ),
            ).toEqual([]);
        },
    );
});
