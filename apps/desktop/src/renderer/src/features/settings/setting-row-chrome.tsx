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
}: SettingRowChromeProperties) {
    const labelBlock = (
        <FieldContent>
            <span className="flex items-center gap-1.5">
                {labelFor ? (
                    <FieldLabel htmlFor={labelFor}>{row.title}</FieldLabel>
                ) : (
                    <FieldTitle>{row.title}</FieldTitle>
                )}
                {modified && resettable && (
                    <Tooltip content="Reset to default">
                        <Button
                            aria-label={`Reset ${row.accessibleTitle} to default`}
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
                            aria-label={`More about ${row.accessibleTitle}`}
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
            className="group/setting relative rounded-md px-3 py-2 hover:bg-[color-mix(in_srgb,var(--elevated)_45%,transparent)]"
        >
            {modified && (
                <span
                    aria-hidden="true"
                    className="absolute inset-y-2 left-0 w-[3px] rounded-full bg-[color-mix(in_srgb,var(--accent)_60%,transparent)]"
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
                <Field orientation="horizontal" className="min-h-9 items-start gap-4">
                    {labelBlock}
                    {control}
                </Field>
            )}
        </div>
    );
}
