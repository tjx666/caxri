import type { ReactNode } from 'react';

import { Info, RotateCcw } from 'lucide-react';

import { Button } from '../../components/ui/button';
import {
    Field,
    FieldContent,
    FieldDescription,
    FieldLabel,
    FieldTitle,
} from '../../components/ui/field';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { hasOwnSurface } from './setting-row-layout';
import type { SettingRowDescriptor } from './settings-registry';

interface SettingRowChromeProperties {
    row: SettingRowDescriptor;
    modified: boolean;
    resettable: boolean;
    onReset: () => void;
    /**
     * Rendered right of the label block (horizontal rows) or under it (full-width rows).
     */
    control: ReactNode;
    /**
     * Optional live status caption under the description (hook health).
     */
    status?: ReactNode;
    /**
     * A full-width row's own on/off switch, kept at the row's right end like every other toggle in Settings while its
     * expanded fields stay below. Without this the switch fell under the description and left-aligned, so one screen
     * showed the same control in two places.
     */
    toggle?: ReactNode;
    fullWidth: boolean;
    labelFor?: string;
    /**
     * Tags an advanced row listed while advanced rows are hidden, so it reads as found rather than as a row that will
     * stay after the search is cleared.
     */
    showAdvancedTag?: boolean;
}

/**
 * Shared chrome around every Settings row's control: title, description, info and reset affordances, and the modified
 * dot. The control itself is resolved by `SettingRow` from the row's binding; the card the row sits in is drawn by
 * `SettingsPage`.
 */
export function SettingRowChrome({
    row,
    modified,
    resettable,
    onReset,
    control,
    status,
    toggle,
    fullWidth,
    labelFor,
    showAdvancedTag,
}: SettingRowChromeProperties) {
    const { t } = useTranslation();
    if (hasOwnSurface(row))
        return (
            // The heading right above already names this row, so its title stays only as the group's accessible name.
            <div
                aria-label={row.accessibleTitle}
                data-setting-row={row.id}
                role="group"
                className="flex flex-col gap-2"
            >
                {row.description && (
                    <FieldDescription className="max-w-xl px-1">{row.description}</FieldDescription>
                )}
                {status}
                {control}
            </div>
        );
    const labelBlock = (
        <FieldContent className={fullWidth ? 'gap-0.5' : 'flex-[1_1_12rem] gap-0.5'}>
            <span className="flex items-center gap-1.5">
                {labelFor ? (
                    <FieldLabel className="font-medium" htmlFor={labelFor}>
                        {row.title}
                    </FieldLabel>
                ) : (
                    <FieldTitle className="font-medium">{row.title}</FieldTitle>
                )}
                {/*
                 * A dot beside the title, not a bar on the row edge: inside a card the edge belongs to the card, and
                 * a bar there would read as the card's own border.
                 */}
                {modified && (
                    <Tooltip content={t('settings.page.modified')}>
                        <span
                            aria-label={t('settings.page.modified')}
                            role="img"
                            className="size-1.5 shrink-0 rounded-full bg-state-marker"
                        />
                    </Tooltip>
                )}
                {showAdvancedTag && (
                    <span className="rounded-sm bg-elevated px-1 text-[10px] leading-4 text-muted">
                        {t('settings.page.advancedTag')}
                    </span>
                )}
                {modified && resettable && (
                    <Tooltip content={t('settings.page.resetToDefault')}>
                        <Button
                            aria-label={t('settings.page.resetRowToDefault', {
                                title: row.accessibleTitle,
                            })}
                            className="size-5 min-h-0 p-0 text-muted opacity-0 group-focus-within/setting:opacity-100 group-hover/setting:opacity-100 hover:text-foreground"
                            size="icon"
                            variant="ghost"
                            onClick={onReset}
                        >
                            <RotateCcw size={12} />
                        </Button>
                    </Tooltip>
                )}
                {row.detail && (
                    <Tooltip content={row.detail}>
                        <Button
                            aria-label={t('settings.page.moreAbout', {
                                title: row.accessibleTitle,
                            })}
                            className="size-5 min-h-0 p-0 text-muted hover:text-foreground"
                            size="icon"
                            variant="ghost"
                        >
                            <Info size={12} />
                        </Button>
                    </Tooltip>
                )}
            </span>
            {row.description && (
                <FieldDescription className="max-w-xl">{row.description}</FieldDescription>
            )}
            {status}
        </FieldContent>
    );
    return (
        <div data-setting-row={row.id} className="group/setting px-4 py-3">
            {fullWidth ? (
                <Field className="gap-2">
                    {toggle ? (
                        <div className="flex min-h-9 w-full items-start gap-6">
                            {labelBlock}
                            {toggle}
                        </div>
                    ) : (
                        labelBlock
                    )}
                    {control}
                </Field>
            ) : (
                /*
                 * Wraps instead of squeezing: once the label block cannot keep 12rem beside the control, the control
                 * drops under the description, so a narrow pane never breaks a title one word per line.
                 */
                <Field
                    orientation="horizontal"
                    className="min-h-9 flex-wrap items-start gap-x-6 gap-y-2"
                >
                    {labelBlock}
                    {control}
                </Field>
            )}
        </div>
    );
}
