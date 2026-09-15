import type { ViewCatalogSnapshot } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { aggregateContainerBadges, badgeViews, selectContainerBadge } from '../view-badges';

describe('view badges', () => {
    /**
     * The bug this replaced: a severity that also had a tally rendered the digit and let the fill carry the severity,
     * so the Status tab's `9` and the Git tab's `120` were the same size, shape, and position and differed only by
     * color. Severity now takes the chip outright and the displaced tallies stay in the description.
     */
    it('lets a severity replace a tally and keeps every contributing description', () => {
        expect(
            selectContainerBadge([
                { kind: 'count', count: 2, description: '2 changes' },
                { kind: 'error', description: '9 failures' },
                { kind: 'warning', description: '4 warnings' },
            ]),
        ).toEqual({ kind: 'error', description: '2 changes, 9 failures, 4 warnings' });
    });

    it('ranks error above warning above count and never blends two rungs', () => {
        expect(
            selectContainerBadge([
                { kind: 'warning', description: 'Stale deployment' },
                { kind: 'count', count: 3, description: '3 changes' },
            ]),
        ).toEqual({ kind: 'warning', description: 'Stale deployment, 3 changes' });
        expect(
            selectContainerBadge([{ kind: 'error', description: 'Pipeline failed' }]),
        ).not.toHaveProperty('text');
    });

    it('totals only plain tallies, caps the digit, and hides an all-zero container', () => {
        expect(
            selectContainerBadge([
                { kind: 'count', count: 2, description: '2 changes' },
                { kind: 'count', count: 3, description: '3 more' },
            ]),
        ).toEqual({ kind: 'count', text: '5', description: '2 changes, 3 more' });
        expect(
            selectContainerBadge([{ kind: 'count', count: 120, description: '120 changes' }]),
        ).toEqual({ kind: 'count', text: '99+', description: '120 changes' });
        expect(selectContainerBadge([])).toBeUndefined();
        expect(
            selectContainerBadge([{ kind: 'count', count: 0, description: 'No changes' }]),
        ).toBeUndefined();
        // A zero tally alongside a severity drops out of the description too: it contributes nothing.
        expect(
            selectContainerBadge([
                { kind: 'count', count: 0, description: 'No changes' },
                { kind: 'error', description: 'Pipeline failed' },
            ]),
        ).toEqual({ kind: 'error', description: 'Pipeline failed' });
    });

    it('groups every view by container and drops containers with nothing to show', () => {
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
                { containerId: 'status', badge: { kind: 'error', description: '9 failures' } },
                { containerId: 'empty', badge: null },
                {
                    containerId: 'zero',
                    badge: { kind: 'count', count: 0, description: 'No changes' },
                },
            ]),
        ).toEqual({
            git: { kind: 'count', text: '99+', description: '120 changes' },
            status: { kind: 'error', description: '2 changes, 9 failures' },
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
