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
 * bar. The control itself is resolved by `SettingRow` from the row's binding.
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
    const labelBlock = (
        <FieldContent className={fullWidth ? undefined : 'flex-[1_1_12rem]'}>
            <span className="flex items-center gap-1.5">
                {labelFor ? (
                    <FieldLabel htmlFor={labelFor}>{row.title}</FieldLabel>
                ) : (
                    <FieldTitle>{row.title}</FieldTitle>
                )}
                {showAdvancedTag && (
                    <span className="rounded-sm border border-border px-1 text-[10px] leading-4 text-muted">
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
        <div
            data-setting-row={row.id}
            className="group/setting relative rounded-md px-3 py-2 hover:bg-state-hover-quiet"
        >
            {modified && (
                <span
                    aria-hidden="true"
                    className="absolute inset-y-2 left-0 w-[3px] rounded-full bg-state-marker"
                />
            )}
            {fullWidth ? (
                <Field className="gap-2">
                    {toggle ? (
                        <div className="flex min-h-9 w-full items-start gap-4">
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
                <Field orientation="horizontal" className="min-h-9 flex-wrap items-start gap-4">
                    {labelBlock}
                    {control}
                </Field>
            )}
        </div>
    );
}
