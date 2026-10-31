import type { AgentProvider, SettingCategoryId, SettingSpec } from '@caxri/protocol';
import {
    agentProviderCatalog,
    agentProviderIds,
    settingCategories,
    settingsSpecByKey,
} from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { useTranslation } from '../../i18n';
import {
    settingCategoryTitle,
    settingDescription,
    settingOptionLabel,
    settingTitle,
} from './setting-spec-text';
import type { SettingRowBinding, SettingRowSource } from './settings-row-sources';
import { lower, settingRowSources } from './settings-row-sources';

export type { SettingRowBinding } from './settings-row-sources';

export interface SettingRowDescriptor {
    /**
     * Stable unique id: the settings key, or a purpose-named id for non-settings rows.
     */
    id: string;
    category: SettingCategoryId;
    /**
     * Secondary grouping rendered as an inline heading and an indented TOC entry (Agents).
     */
    subcategory?: string;
    title: string;
    /**
     * Accessible name for the row's control, which is `title` unless another row shares it.
     *
     * The Settings page is one flat virtualized list, so a category heading is a sibling of its rows rather than a
     * container that owns them. Assistive technology therefore reads a control's name with no trace of the heading
     * above it, and "Font size" under Terminal is indistinguishable from "Font size" under Editor. A duplicated title
     * is prefixed with its category so the name stays unique app-wide; the visible label keeps the short title, which
     * WCAG 2.5.3 allows because the accessible name still contains it. Duplicates are counted per locale, since two
     * titles distinct in one language can coincide in another.
     */
    accessibleTitle: string;
    description?: string;
    /**
     * Longer explanation shown from an inline info affordance next to the title, for a row whose `description` was
     * shortened to fit its row height but still owes the reader the mechanics it dropped (e.g. Delegation depth's
     * worked examples). Most rows have no `detail` and rely on `description` alone.
     */
    detail?: string;
    /**
     * A boolean setting this row only applies under (see `SettingRowSource.enabledBy`).
     */
    enabledBy?: SettingRowSource['enabledBy'];
    /**
     * Listed only under Show advanced settings, while searching, or when a request scrolls to it (see
     * `SettingRowSource.advanced`).
     */
    advanced: boolean;
    binding: SettingRowBinding;
    /**
     * Lowercased text corpus the settings search matches against: the English source text and keywords plus the active
     * locale's text, so a query in either language finds the row.
     */
    haystack: string;
}

export interface SettingsCategory {
    id: SettingCategoryId;
    title: string;
    subcategories: string[];
}

export interface SettingsRegistry {
    /**
     * Display-order authority for the Settings page: rows grouped by category, flattened top to bottom. The table of
     * contents, the virtualized list, and search all derive from this array. Category and subcategory titles join each
     * row's haystack so "terminal" or "claude" matches the whole group.
     */
    rows: SettingRowDescriptor[];
    /**
     * Categories in display order, each with its ordered distinct subcategories.
     */
    categories: SettingsCategory[];
}

/**
 * Bindings whose control takes its accessible name from the row title, and therefore need a category prefix when two
 * rows share that title. Every other binding renders a dedicated editor that already names itself after the thing it
 * edits (`Claude Code lifecycle hooks`), so prefixing it would rename a row that was never ambiguous. Keep this in step
 * with the `row.accessibleTitle` uses in `setting-row.tsx`.
 */
export const titleNamedBindings = new Set<SettingRowBinding['type']>([
    'delegation-depth',
    'hardware-acceleration',
    'remote-debugging',
    'setting',
]);

const englishCategoryTitles = Object.fromEntries(
    settingCategories.map((category) => [category.id, category.title]),
) as Record<SettingCategoryId, string>;

/**
 * Active-locale text of the catalog entry a row searches by, so its translated title, description, and option labels
 * are searchable alongside the English ones already in `searchTerms`.
 */
function translatedSpecTerms(t: Translate, source: SettingRowSource): string[] {
    if (source.searchSpec === undefined) return [];
    const spec: SettingSpec = settingsSpecByKey[source.searchSpec];
    return [
        settingTitle(t, source.searchSpec),
        settingDescription(t, spec),
        ...(spec.kind === 'enum'
            ? spec.options.map((option) => settingOptionLabel(t, spec, option.value))
            : []),
    ].filter((term): term is string => term !== undefined);
}

/**
 * Translates every row and category for the locale `t` renders. Prefer `getSettingsRegistry`, which memoizes per
 * translator.
 */
function buildSettingsRegistry(t: Translate): SettingsRegistry {
    const translated = settingRowSources.map((source) => ({
        source,
        title: t(source.titleKey),
        description: source.descriptionKey === undefined ? undefined : t(source.descriptionKey),
        detail: source.detailKey === undefined ? undefined : t(source.detailKey),
    }));
    const titleCounts = new Map<string, number>();
    for (const { source, title } of translated)
        if (titleNamedBindings.has(source.binding.type))
            titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
    const rows = translated.map(({ source, title, description, detail }) => {
        const categoryTitle = settingCategoryTitle(t, source.category);
        return {
            id: source.id,
            category: source.category,
            subcategory: source.subcategory,
            title,
            accessibleTitle:
                (titleCounts.get(title) ?? 0) > 1
                    ? t('settings.page.accessibleTitle', { category: categoryTitle, title })
                    : title,
            description,
            detail,
            enabledBy: source.enabledBy,
            advanced: source.advanced ?? false,
            binding: source.binding,
            haystack: lower([
                source.searchTerms,
                title,
                description,
                ...translatedSpecTerms(t, source),
                englishCategoryTitles[source.category],
                categoryTitle,
                source.subcategory,
            ]),
        } satisfies SettingRowDescriptor;
    });
    const categories = settingCategories.map((category) => ({
        id: category.id,
        title: settingCategoryTitle(t, category.id),
        subcategories: [
            ...new Set(
                rows.flatMap((row) =>
                    row.category === category.id && row.subcategory !== undefined
                        ? [row.subcategory]
                        : [],
                ),
            ),
        ],
    }));
    return { rows, categories };
}

/**
 * One registry per locale. Keyed by the translated title of the first row rather than by `t`, because `translate` (one
 * function for every locale) answers in whichever language is current, while `useTranslation()`'s `t` for the same
 * locale produces the same text.
 */
const registryCache = new Map<string, SettingsRegistry>();

export function getSettingsRegistry(t: Translate): SettingsRegistry {
    const localeProbe = t(settingRowSources[0].titleKey);
    let registry = registryCache.get(localeProbe);
    if (!registry) {
        registry = buildSettingsRegistry(t);
        registryCache.set(localeProbe, registry);
    }
    return registry;
}

/**
 * The Settings registry in the active language, re-rendering the caller when the language changes.
 */
export function useSettingsRegistry(): SettingsRegistry {
    const { t } = useTranslation();
    return getSettingsRegistry(t);
}

/**
 * Resolves a subcategory heading back to its Agent provider for identity icons.
 */
export function agentProviderForSubcategory(title: string): AgentProvider | undefined {
    return agentProviderIds.find(
        (provider) => agentProviderCatalog[provider].displayName === title,
    );
}
