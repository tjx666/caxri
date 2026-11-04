import { describe, expect, it } from 'vitest';

import type { SettingRowDescriptor, SettingSubcategory } from '../settings-registry';
import type { SettingsListItem } from '../settings-search';
import { settingsActiveAnchor, settingsAnchorOf } from '../settings-toc';

const codex: SettingSubcategory = {
    id: 'codex',
    title: 'Codex',
    provider: 'codex',
    listedInNavigation: true,
};
const appearance: SettingSubcategory = {
    id: 'appearance',
    title: 'Appearance',
    listedInNavigation: false,
};

const row = (
    id: string,
    category: SettingRowDescriptor['category'],
    subcategory?: SettingSubcategory,
): SettingsListItem => ({
    kind: 'row',
    id,
    row: {
        id,
        category,
        subcategory,
        title: id,
        accessibleTitle: id,
        advanced: false,
        binding: { type: 'setting', key: 'terminal.fontSize' },
        haystack: id,
    },
    card: { first: true, last: true },
});

const list: SettingsListItem[] = [
    {
        kind: 'category',
        id: 'c:files',
        category: { id: 'files', title: 'Files', subcategories: [] },
    },
    row('files.a', 'files'),
    {
        kind: 'category',
        id: 'c:agents',
        category: { id: 'agents', title: 'Agent', subcategories: [codex] },
    },
    row('agents.a', 'agents'),
    { kind: 'subcategory', id: 's:codex', categoryId: 'agents', subcategory: codex },
    row('agents.codex.a', 'agents', codex),
];

/**
 * Item extents as TanStack Virtual reports them: integer starts from rounded measurements.
 */
const items = [
    { index: 0, end: 42 },
    { index: 1, end: 9240 },
    { index: 2, end: 9282 },
    { index: 3, end: 9338 },
    { index: 4, end: 9372 },
    { index: 5, end: 9428 },
];

describe('settingsAnchorOf', () => {
    it('names a category by id and a subcategory by category and id', () => {
        expect(settingsAnchorOf(list[0])).toBe('files');
        expect(settingsAnchorOf(list[4])).toBe('agents:codex');
        expect(settingsAnchorOf(list[1])).toBeUndefined();
    });

    it('names a subcategory the navigation does not list by its category', () => {
        expect(
            settingsAnchorOf({
                kind: 'subcategory',
                id: 's:appearance',
                categoryId: 'general',
                subcategory: appearance,
            }),
        ).toBe('general');
    });
});

describe('settingsActiveAnchor', () => {
    it('picks the heading scrolled exactly to the top', () => {
        expect(settingsActiveAnchor(list, items, 9240)).toBe('agents');
    });

    it('still picks the heading when a zoomed scrollTop reads back a fraction short of it', () => {
        expect(settingsActiveAnchor(list, items, 9239.87)).toBe('agents');
        expect(settingsActiveAnchor(list, items, 9338.5)).toBe('agents:codex');
    });

    it('keeps the previous section while more than the tolerance of it is still visible', () => {
        expect(settingsActiveAnchor(list, items, 9238)).toBe('files');
    });

    it('resolves a row to its subcategory, else to its category', () => {
        expect(settingsActiveAnchor(list, items, 9300)).toBe('agents');
        expect(settingsActiveAnchor(list, items, 9400)).toBe('agents:codex');
    });

    it('keeps the category highlighted inside a group the navigation does not list', () => {
        const general: SettingsListItem[] = [
            {
                kind: 'category',
                id: 'c:general',
                category: { id: 'general', title: 'General', subcategories: [appearance] },
            },
            {
                kind: 'subcategory',
                id: 's:appearance',
                categoryId: 'general',
                subcategory: appearance,
            },
            row('general.theme', 'general', appearance),
        ];
        const extents = [
            { index: 0, end: 52 },
            { index: 1, end: 84 },
            { index: 2, end: 152 },
        ];
        expect(settingsActiveAnchor(general, extents, 60)).toBe('general');
        expect(settingsActiveAnchor(general, extents, 100)).toBe('general');
    });

    it('falls back to the first rendered item past the end and to nothing for an empty list', () => {
        expect(settingsActiveAnchor(list, items, 20_000)).toBe('files');
        expect(settingsActiveAnchor([], [], 0)).toBeUndefined();
    });
});
