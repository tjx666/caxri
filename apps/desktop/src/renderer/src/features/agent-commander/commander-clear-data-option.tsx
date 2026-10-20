import type { ReactNode } from 'react';

import { Checkbox } from '../../components/ui/checkbox';

/**
 * One kind of Commander data: a checkbox labelled by its title, what it is, and how much there is. An entry with
 * nothing in it stays listed but disabled, so the list keeps its shape and says there is nothing to clear.
 */
export function CommanderClearDataOption({
    children,
    description,
    id,
    isChecked,
    isDisabled,
    meta,
    onCheckedChange,
    title,
}: {
    children?: ReactNode;
    description: string;
    id: string;
    isChecked: boolean;
    isDisabled: boolean;
    meta?: string;
    onCheckedChange: (isChecked: boolean) => void;
    title: string;
}) {
    return (
        <div
            className="commander-clear-data-option grid gap-2 rounded-md px-2 py-2 data-[checked=true]:bg-state-selected-quiet"
            data-checked={isChecked}
            data-clear-data={id}
        >
            <label className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 has-[[data-disabled]]:cursor-default">
                <Checkbox
                    className="mt-0.5"
                    checked={isChecked}
                    disabled={isDisabled}
                    onCheckedChange={(next) => onCheckedChange(next === true)}
                />
                <span className="grid gap-0.5">
                    <span className="text-[13px] text-foreground">{title}</span>
                    <span className="text-[11px] leading-[1.45] text-muted">{description}</span>
                </span>
                {meta && (
                    <span className="pt-0.5 text-right text-[11px] whitespace-nowrap text-muted tabular-nums">
                        {meta}
                    </span>
                )}
            </label>
            {children && <div className="pl-7">{children}</div>}
        </div>
    );
}
