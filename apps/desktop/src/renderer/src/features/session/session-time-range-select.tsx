import type { ReactNode } from 'react';

import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '../../components/ui/select';
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
    triggerClassName,
    value,
}: {
    ariaLabel: string;
    id?: string;
    leading?: ReactNode;
    onChange: (value: SessionTimeRange) => void;
    triggerClassName?: string;
    value: SessionTimeRange;
}) {
    const { t } = useTranslation();
    return (
        <Select value={value} onValueChange={(next) => onChange(next ?? 'all')}>
            <SelectTrigger
                aria-label={ariaLabel}
                className={triggerClassName}
                data-session-time-range={value}
                id={id}
            >
                {leading}
                <SelectValue>{t(sessionTimeRangeLabelKeys[value])}</SelectValue>
            </SelectTrigger>
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
