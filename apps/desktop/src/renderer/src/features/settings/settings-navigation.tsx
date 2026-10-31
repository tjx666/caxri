import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utilities';

import type { TranslationKey } from '../../i18n';
import { useTranslation } from '../../i18n';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import type { ConfigKind } from './config-edit';
import type { SettingsCategory } from './settings-registry';
import { agentProviderForSubcategory } from './settings-registry';

/**
 * A hovered entry gets a lighter wash than the current one, which also takes a heavier weight, so the entry under the
 * pointer never reads as a second current location.
 */
const ENTRY_CLASS =
    'w-full justify-start border-0 text-left text-[12px] font-normal text-muted hover:text-foreground';
const ACTIVE_CLASS = 'bg-elevated font-medium text-foreground enabled:hover:bg-elevated';

/**
 * The two configuration files that are not schema categories of `settings.jsonc`, listed after them in the same column.
 */
const FILE_SECTIONS: ReadonlyArray<{
    kind: Exclude<ConfigKind, 'settings'>;
    label: TranslationKey;
}> = [
    { kind: 'keybindings', label: 'settings.page.tab.keybindings' },
    { kind: 'theme', label: 'settings.page.tab.theme' },
];

export interface SettingsNavigationProperties {
    categories: SettingsCategory[];
    /**
     * The section whose content is showing: `settings` lists the categories as its own table of contents.
     */
    section: ConfigKind;
    /**
     * Rows matching the current search per category and `category:subcategory` anchor; only read while filtered.
     */
    counts?: Partial<Record<string, number>>;
    activeAnchor?: string;
    searching?: boolean;
    /**
     * Rows are filtered (a query, or advanced rows hidden): entries with no listed rows are hidden as dead clicks.
     */
    filtered?: boolean;
    onNavigate: (anchor: string) => void;
    onSectionChange: (section: ConfigKind) => void;
}

/**
 * The one Settings navigation column: the `settings.jsonc` categories (the table of contents of the Settings section),
 * then Keybindings and Theme. It replaced a horizontal Settings / Keybindings / Theme strip above a second, vertical
 * table of contents, which stacked two navigations for one page inside a Workbench tab that already sits under two tab
 * rows. The column renders identically for every section so switching sections never moves it.
 */
export function SettingsNavigation({
    categories,
    section,
    counts = {},
    activeAnchor,
    searching = false,
    filtered = searching,
    onNavigate,
    onSectionChange,
}: SettingsNavigationProperties) {
    const { t } = useTranslation();
    const isSettings = section === 'settings';
    return (
        <nav
            aria-label={t('settings.page.categoriesNav')}
            className="min-h-0 overflow-y-auto py-2 pl-2"
        >
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                {categories.map((category) => {
                    const count = counts[category.id] ?? 0;
                    if (filtered && count === 0) return null;
                    // A subcategory carries the location on its own, so `aria-current` names exactly one entry.
                    const isActive = isSettings && activeAnchor === category.id;
                    return (
                        <li key={category.id}>
                            <Button
                                variant="ghost"
                                size="sm"
                                type="button"
                                aria-current={isActive ? 'location' : undefined}
                                className={cn(
                                    ENTRY_CLASS,
                                    'justify-between gap-2',
                                    isActive && ACTIVE_CLASS,
                                )}
                                onClick={() => onNavigate(category.id)}
                            >
                                <span className="truncate">{category.title}</span>
                                {searching && (
                                    <span className="text-[10px] text-muted tabular-nums">
                                        {count}
                                    </span>
                                )}
                            </Button>
                            {category.subcategories.length > 0 && (
                                <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                                    {category.subcategories.map((subcategory) => {
                                        const anchor = `${category.id}:${subcategory}`;
                                        // A subcategory with no matches has no heading in the
                                        // filtered list, so its entry would be a dead click.
                                        if (filtered && (counts[anchor] ?? 0) === 0) return null;
                                        const provider = agentProviderForSubcategory(subcategory);
                                        const isSubActive = isSettings && activeAnchor === anchor;
                                        return (
                                            <li key={anchor}>
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    type="button"
                                                    aria-current={
                                                        isSubActive ? 'location' : undefined
                                                    }
                                                    className={cn(
                                                        ENTRY_CLASS,
                                                        'gap-2 pl-6',
                                                        isSubActive && ACTIVE_CLASS,
                                                    )}
                                                    onClick={() => onNavigate(anchor)}
                                                >
                                                    {provider && (
                                                        <AgentIdentityIcon
                                                            identity={provider}
                                                            size={13}
                                                        />
                                                    )}
                                                    <span className="truncate">{subcategory}</span>
                                                </Button>
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                        </li>
                    );
                })}
            </ul>
            <Separator className="my-2" />
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                {FILE_SECTIONS.map(({ kind, label }) => (
                    <li key={kind}>
                        <Button
                            variant="ghost"
                            size="sm"
                            type="button"
                            aria-current={section === kind ? 'page' : undefined}
                            className={cn(ENTRY_CLASS, section === kind && ACTIVE_CLASS)}
                            onClick={() => onSectionChange(kind)}
                        >
                            <span className="truncate">{t(label)}</span>
                        </Button>
                    </li>
                ))}
            </ul>
        </nav>
    );
}
