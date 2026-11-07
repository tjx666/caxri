import { describe, expect, it } from 'vitest';

import {
    defaultSessionMenuLayout,
    normalizeSessionMenuLayout,
    sessionMenuItemIds,
} from '../session-menu-layout';
import { appSettingsFileSchema } from '../settings-schema';

describe('defaultSessionMenuLayout', () => {
    it('places every item exactly once', () => {
        const items = defaultSessionMenuLayout.order.filter((entry) => entry !== 'separator');
        expect(new Set(items)).toEqual(new Set(sessionMenuItemIds));
        expect(items).toHaveLength(sessionMenuItemIds.length);
    });

    it('is already normalized', () => {
        expect(normalizeSessionMenuLayout(defaultSessionMenuLayout)).toEqual(
            defaultSessionMenuLayout,
        );
    });
});

describe('normalizeSessionMenuLayout', () => {
    it('resolves null to the built-in layout', () => {
        expect(normalizeSessionMenuLayout(null)).toEqual(defaultSessionMenuLayout);
    });

    it('drops unknown and repeated ids and collapses separators', () => {
        const { order } = normalizeSessionMenuLayout({
            order: [
                'separator',
                'archive',
                'removedInAnotherVersion',
                'separator',
                'separator',
                'archive',
                ...sessionMenuItemIds.filter((id) => id !== 'archive'),
                'separator',
            ],
            hidden: [],
        });
        expect(order.slice(0, 3)).toEqual(['archive', 'separator', 'markAsDone']);
        expect(order.at(-1)).toBe('deleteSession');
        expect(order.filter((entry) => entry === 'archive')).toHaveLength(1);
    });

    it('appends items a customized layout omits after a separator', () => {
        const { order } = normalizeSessionMenuLayout({
            order: ['archive', 'deleteSession'],
            hidden: [],
        });
        expect(order.slice(0, 3)).toEqual(['archive', 'deleteSession', 'separator']);
        expect(order.filter((entry) => entry !== 'separator')).toHaveLength(
            sessionMenuItemIds.length,
        );
    });

    it('keeps only known hidden ids', () => {
        expect(
            normalizeSessionMenuLayout({
                order: [...sessionMenuItemIds],
                hidden: ['handOverToBot', 'unknown', 'handOverToBot'],
            }).hidden,
        ).toEqual(['handOverToBot']);
    });
});

describe('primarySidebar.sessionMenu file parsing', () => {
    it('defaults to null so the built-in order keeps following Caxri', () => {
        expect(appSettingsFileSchema.parse({})['primarySidebar.sessionMenu']).toBeNull();
    });

    it('normalizes a hand-edited layout instead of failing the file', () => {
        const parsed = appSettingsFileSchema.parse({
            'primarySidebar.sessionMenu': { order: ['archive', 'bogus'] },
        })['primarySidebar.sessionMenu'];
        expect(parsed?.order[0]).toBe('archive');
        expect(parsed?.order).not.toContain('bogus');
        expect(parsed?.hidden).toEqual([]);
    });
});
