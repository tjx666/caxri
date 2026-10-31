import { afterEach, describe, expect, it } from 'vitest';

import { translate, useLocaleStore } from '../../../i18n';
import type { SettingRowDescriptor, SettingsCategory } from '../settings-registry';
import { getSettingsRegistry } from '../settings-registry';
import { buildSettingsList, countRowsByCategory, filterSettingsRows } from '../settings-search';

const row = (
    id: string,
    category: SettingRowDescriptor['category'],
    haystack: string,
    subcategory?: string,
): SettingRowDescriptor => ({
    id,
    category,
    subcategory,
    title: id,
    accessibleTitle: id,
    binding: { type: 'setting', key: 'terminal.fontSize' },
    haystack,
});

const { categories: settingsCategories, rows: settingsRows } = getSettingsRegistry(translate);

const categories: SettingsCategory[] = [
    { id: 'general', title: 'General', subcategories: [] },
    { id: 'agents', title: 'Agents', subcategories: ['Claude Code', 'Codex'] },
];

describe('filterSettingsRows', () => {
    it('keeps every row for an empty or blank query', () => {
        const rows = [row('a', 'general', 'alpha'), row('b', 'agents', 'beta')];
        expect(filterSettingsRows(rows, '')).toHaveLength(2);
        expect(filterSettingsRows(rows, ' '.repeat(3))).toHaveLength(2);
    });

    it('requires every whitespace-separated token to match (AND semantics)', () => {
        const rows = [
            row('a', 'general', 'terminal font size'),
            row('b', 'general', 'terminal scrollback'),
        ];
        expect(filterSettingsRows(rows, 'terminal font').map((r) => r.id)).toEqual(['a']);
        expect(filterSettingsRows(rows, 'TERMINAL')).toHaveLength(2);
        expect(filterSettingsRows(rows, 'terminal missing')).toHaveLength(0);
    });

    it('matches real registry rows by category title and provider name', () => {
        const byCategoryWord = filterSettingsRows(settingsRows, 'terminal');
        expect(byCategoryWord.some((r) => r.id === 'terminal.fontSize')).toBe(true);
        const byProvider = filterSettingsRows(settingsRows, 'claude');
        expect(byProvider.length).toBeGreaterThan(0);
        expect(byProvider.every((r) => r.haystack.includes('claude'))).toBe(true);
        expect(filterSettingsRows(settingsRows, 'codex timeout').map((r) => r.id)).toEqual([
            'agents.codex.recovery',
        ]);
        expect(
            filterSettingsRows(settingsRows, 'Agent Commands & Skills').map((r) => r.id),
        ).toEqual([
            'agents.claude.actions',
            'agents.codex.actions',
            'agents.grok.actions',
            'agents.antigravity.actions',
        ]);
        expect(filterSettingsRows(settingsRows, 'mobile qr').map((r) => r.id)).toEqual([
            'mobile.access',
        ]);
    });

    /**
     * `agents.delegation` is a complex value with no scalar spec, so for a long time it declared search keywords while
     * rendering no row at all: searching the word that names the feature returned nothing. A row now owns the depth,
     * and the words a user would actually type for it have to keep reaching that row.
     */
    it('finds the Agent delegation row by the words that name the feature', () => {
        for (const query of ['delegation', 'delegate', 'preset', 'depth', 'caller', 'effort'])
            expect(
                filterSettingsRows(settingsRows, query).map((r) => r.id),
                query,
            ).toContain('agents.delegation.maxDepth');
    });

    /**
     * The debugging-port row used to be titled and described in protocol vocabulary, so the words a worried user types
     * did not reach it. The rewrite has to stay reachable by both the old jargon and the plain words.
     */
    it('finds the debugging port row by both its jargon and its plain words', () => {
        for (const query of ['cdp', 'remote debugging', 'devtools', 'debugging port'])
            expect(
                filterSettingsRows(settingsRows, query).map((r) => r.id),
                query,
            ).toContain('security.remoteDebugging');
    });
});

describe('settings search in Simplified Chinese', () => {
    afterEach(() => useLocaleStore.setState({ locale: 'en' }));

    /**
     * The haystack keeps the English corpus beside the active locale's text, so a Chinese reader can search in Chinese
     * while an English keyword (or a setting key copied from `settings.jsonc`) still finds the row.
     */
    it('matches both the translated text and the English source', () => {
        useLocaleStore.setState({ locale: 'zh-CN' });
        const { rows } = getSettingsRegistry(translate);
        const terminalFontSize = rows.find((r) => r.id === 'terminal.fontSize');
        expect(terminalFontSize?.title).toBe('字号');
        for (const query of ['字号', '终端 字号', 'font size', 'terminal.fontSize'])
            expect(
                filterSettingsRows(rows, query).map((r) => r.id),
                query,
            ).toContain('terminal.fontSize');
        expect(filterSettingsRows(rows, '硬件加速').map((r) => r.id)).toContain(
            'terminal.hardwareAcceleration',
        );
        expect(filterSettingsRows(rows, 'hardware acceleration').map((r) => r.id)).toContain(
            'terminal.hardwareAcceleration',
        );
    });

    it('keeps accessible names unique in the translated registry', () => {
        useLocaleStore.setState({ locale: 'zh-CN' });
        const names = getSettingsRegistry(translate)
            .rows.filter((r) => r.binding.type === 'setting')
            .map((r) => r.accessibleTitle);
        expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
        expect(names).toContain('终端 字号');
    });
});

describe('buildSettingsList', () => {
    it('emits a category heading before its first visible row and drops empty categories', () => {
        const rows = [row('a', 'general', 'alpha')];
        const list = buildSettingsList(categories, rows);
        expect(list.map((item) => item.id)).toEqual(['category:general', 'a']);
    });

    it('emits a subcategory heading whenever the subcategory changes', () => {
        const rows = [
            row('c1', 'agents', 'x', 'Claude Code'),
            row('c2', 'agents', 'x', 'Claude Code'),
            row('x1', 'agents', 'x', 'Codex'),
        ];
        const list = buildSettingsList(categories, rows);
        expect(list.map((item) => item.id)).toEqual([
            'category:agents',
            'subcategory:agents:Claude Code',
            'c1',
            'c2',
            'subcategory:agents:Codex',
            'x1',
        ]);
    });

    it('flattens the full registry with unique ids in display order', () => {
        const list = buildSettingsList(settingsCategories, settingsRows);
        const ids = list.map((item) => item.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(list.filter((item) => item.kind === 'row')).toHaveLength(settingsRows.length);
        expect(list[0]).toMatchObject({ kind: 'category' });
        expect(ids).toContain('category:mobile');
        expect(ids).toContain('mobile.access');
    });
});

describe('countRowsByCategory', () => {
    it('counts visible rows per category', () => {
        const rows = [row('a', 'general', 'x'), row('b', 'general', 'x'), row('c', 'agents', 'x')];
        expect(countRowsByCategory(rows)).toEqual({ agents: 1, general: 2 });
    });

    it('counts subcategory anchors so the TOC can hide sections with no matches', () => {
        const rows = [
            row('c1', 'agents', 'x', 'Claude Code'),
            row('c2', 'agents', 'x', 'Claude Code'),
        ];
        const counts = countRowsByCategory(rows);
        expect(counts['agents:Claude Code']).toBe(2);
        // A filtered-out subcategory has no anchor entry, so its TOC button disappears while
        // searching instead of navigating to a heading that is absent from the filtered list.
        expect(counts['agents:Codex']).toBeUndefined();
    });
});
