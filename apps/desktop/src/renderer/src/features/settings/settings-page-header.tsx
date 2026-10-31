import type { Ref } from 'react';

import { Switch } from '../../components/ui/switch';
import { useTranslation } from '../../i18n';
import { setShowAdvancedSettings } from './settings-advanced-store';
import { SettingsSearchInput } from './settings-search-input';

/**
 * The Settings list's header: search, the match count while searching, and the Show advanced settings switch.
 */
export function SettingsPageHeader({
    inputRef,
    query,
    onQueryChange,
    showAdvanced,
    totalCount,
    visibleCount,
}: {
    inputRef: Ref<HTMLInputElement>;
    query: string;
    onQueryChange: (query: string) => void;
    showAdvanced: boolean;
    totalCount: number;
    visibleCount: number;
}) {
    const { t } = useTranslation();
    return (
        <div className="border-b border-border p-3 pb-2">
            <SettingsSearchInput
                inputRef={inputRef}
                label={t('settings.page.search')}
                placeholder={t('settings.page.search')}
                clearTooltip={t('settings.page.clearSearch')}
                clearLabel={t('settings.page.clearSearchLabel')}
                value={query}
                onChange={onQueryChange}
            />
            <div className="mt-2 flex min-h-5 items-center justify-between gap-3">
                {query.trim().length > 0 ? (
                    <p className="m-0 text-[11px] text-muted" role="status">
                        {t('settings.page.searchCount', {
                            total: totalCount,
                            visible: visibleCount,
                        })}
                    </p>
                ) : (
                    <span />
                )}
                <label className="flex items-center gap-2 text-[12px] text-muted">
                    {t('settings.page.showAdvanced')}
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
