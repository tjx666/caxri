import { describe, expect, it } from 'vitest';

import type { SettingRowDescriptor } from '../settings-registry';
import type { SettingsListItem } from '../settings-search';
import { settingsActiveAnchor, settingsAnchorOf } from '../settings-toc';

const row = (
    id: string,
    category: SettingRowDescriptor['category'],
    subcategory?: string,
): SettingsListItem => ({
    kind: 'row',
    id,
    row: {
        id,
        category,
        subcategory,
        title: id,
        accessibleTitle: id,
        binding: { type: 'setting', key: 'terminal.fontSize' },
        haystack: id,
    },
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
        category: { id: 'agents', title: 'Agent', subcategories: ['Codex'] },
    },
    row('agents.a', 'agents'),
    { kind: 'subcategory', id: 's:codex', categoryId: 'agents', title: 'Codex' },
    row('agents.codex.a', 'agents', 'Codex'),
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
    it('names a category by id and a subcategory by category and title', () => {
        expect(settingsAnchorOf(list[0])).toBe('files');
        expect(settingsAnchorOf(list[4])).toBe('agents:Codex');
        expect(settingsAnchorOf(list[1])).toBeUndefined();
    });
});

describe('settingsActiveAnchor', () => {
    it('picks the heading scrolled exactly to the top', () => {
        expect(settingsActiveAnchor(list, items, 9240)).toBe('agents');
    });

    it('still picks the heading when a zoomed scrollTop reads back a fraction short of it', () => {
        expect(settingsActiveAnchor(list, items, 9239.87)).toBe('agents');
        expect(settingsActiveAnchor(list, items, 9338.5)).toBe('agents:Codex');
    });

    it('keeps the previous section while more than the tolerance of it is still visible', () => {
        expect(settingsActiveAnchor(list, items, 9238)).toBe('files');
    });

    it('resolves a row to its subcategory, else to its category', () => {
        expect(settingsActiveAnchor(list, items, 9300)).toBe('agents');
        expect(settingsActiveAnchor(list, items, 9400)).toBe('agents:Codex');
    });

    it('falls back to the first rendered item past the end and to nothing for an empty list', () => {
        expect(settingsActiveAnchor(list, items, 20_000)).toBe('files');
        expect(settingsActiveAnchor([], [], 0)).toBeUndefined();
    });
});
