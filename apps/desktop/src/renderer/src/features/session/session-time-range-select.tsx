import type { ReactElement, ReactNode } from 'react';

import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '../../components/ui/select';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import type { SessionTimeRange } from './session-time-range';
import { sessionTimeRangeLabelKeys, sessionTimeRanges } from './session-time-range';

/**
 * The time range dropdown shared by the Archived Sessions dialog and Session search, so both offer the same windows
 * with the same labels. `triggerClassName` and `leading` let the search filter bar render it as one of its compact
 * chips while the archive dialog keeps the full-size field.
 */
export function SessionTimeRangeSelect({
    ariaLabel,
    id,
    leading,
    onChange,
    shortcut,
    triggerClassName,
    value,
}: {
    ariaLabel: string;
    id?: string;
    leading?: ReactNode;
    onChange: (value: SessionTimeRange) => void;
    /**
     * When set, the trigger gets a tooltip naming this shortcut, like its sibling filter controls.
     */
    shortcut?: string;
    triggerClassName?: string;
    value: SessionTimeRange;
}) {
    const { t } = useTranslation();
    return (
        <Select value={value} onValueChange={(next) => onChange(next ?? 'all')}>
            <TriggerTooltip label={ariaLabel} shortcut={shortcut}>
                <SelectTrigger
                    aria-label={ariaLabel}
                    className={triggerClassName}
                    data-session-time-range={value}
                    id={id}
                >
                    {leading}
                    <SelectValue>{t(sessionTimeRangeLabelKeys[value])}</SelectValue>
                </SelectTrigger>
            </TriggerTooltip>
            <SelectContent>
                {sessionTimeRanges.map((range) => (
                    <SelectItem key={range} value={range}>
                        {t(sessionTimeRangeLabelKeys[range])}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

function TriggerTooltip({
    children,
    label,
    shortcut,
}: {
    children: ReactElement;
    label: string;
    shortcut?: string;
}) {
    return shortcut ? (
        <Tooltip content={label} shortcut={shortcut}>
            {children}
        </Tooltip>
    ) : (
        children
    );
}
