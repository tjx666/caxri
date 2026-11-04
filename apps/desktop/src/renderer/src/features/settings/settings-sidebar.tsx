import type { ReactNode, Ref } from 'react';

import { Switch } from '../../components/ui/switch';
import { useTranslation } from '../../i18n';
import { setShowAdvancedSettings } from './settings-advanced-store';
import { SettingsSearchInput } from './settings-search-input';

export interface SettingsSidebarProperties {
    searchInputRef: Ref<HTMLInputElement>;
    query: string;
    onQueryChange: (query: string) => void;
    /**
     * Listed and total rows while a query filters the list; absent while the list is not showing.
     */
    searchCount?: { visible: number; total: number };
    showAdvanced: boolean;
    /**
     * Advanced rows the list leaves out; absent while the list is not showing.
     */
    hiddenAdvancedCount?: number;
    /**
     * The Settings navigation, between the search field and the advanced switch.
     */
    children: ReactNode;
}

/**
 * The Settings page's left column, the way macOS System Settings lays it out: search on top, the navigation it narrows
 * under it, and the Show advanced settings switch at the foot. Keeping both list-wide controls here leaves the content
 * column to the settings themselves.
 */
export function SettingsSidebar({
    searchInputRef,
    query,
    onQueryChange,
    searchCount,
    showAdvanced,
    hiddenAdvancedCount = 0,
    children,
}: SettingsSidebarProperties) {
    const { t } = useTranslation();
    const isSearching = query.trim().length > 0;
    return (
        <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-2 py-3">
            <div className="flex flex-col gap-1 pl-3">
                <SettingsSearchInput
                    inputRef={searchInputRef}
                    label={t('settings.page.search')}
                    placeholder={t('settings.page.search')}
                    clearTooltip={t('settings.page.clearSearch')}
                    clearLabel={t('settings.page.clearSearchLabel')}
                    value={query}
                    onChange={onQueryChange}
                />
                {isSearching && searchCount && (
                    <p className="m-0 px-1 text-[11px] text-muted tabular-nums" role="status">
                        {t('settings.page.searchCount', searchCount)}
                    </p>
                )}
            </div>
            {children}
            <div className="pl-3">
                <label className="flex items-center justify-between gap-2 rounded-md px-2 py-2 text-[12px] text-muted hover:bg-state-hover-quiet">
                    <span className="flex min-w-0 flex-col">
                        {t('settings.page.showAdvanced')}
                        {/* A query searches advanced rows too, so nothing is hidden from it. */}
                        {!showAdvanced && !isSearching && hiddenAdvancedCount > 0 && (
                            <span className="text-[11px] tabular-nums">
                                {t(
                                    hiddenAdvancedCount === 1
                                        ? 'settings.page.advancedHiddenOne'
                                        : 'settings.page.advancedHiddenOther',
                                    { count: hiddenAdvancedCount },
                                )}
                            </span>
                        )}
                    </span>
                    <Switch
                        aria-label={t('settings.page.showAdvanced')}
                        checked={showAdvanced}
                        onCheckedChange={setShowAdvancedSettings}
                    />
                </label>
            </div>
        </div>
    );
}
