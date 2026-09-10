import type { ViewCatalogSnapshot } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { aggregateContainerBadges, badgeViews } from '../view-badges';

describe('view badges', () => {
    it('aggregates views within a container and preserves failure priority and full descriptions', () => {
        expect(
            aggregateContainerBadges([
                { containerId: 'git', badge: { count: 120, description: '120 changes' } },
                { containerId: 'status', badge: { count: 2, description: '2 changes' } },
                {
                    containerId: 'status',
                    badge: { count: 9, description: '9 failures', tone: 'danger' },
                },
                { containerId: 'empty', badge: null },
                { containerId: 'zero', badge: { count: 0, description: 'No changes' } },
            ]),
        ).toEqual({
            git: { text: '99+', description: '120 changes', tone: 'neutral' },
            status: { text: '9+', description: '2 changes, 9 failures', tone: 'danger' },
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
