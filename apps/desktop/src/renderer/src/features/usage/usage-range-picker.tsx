import { useState } from 'react';

import type { UsageRange } from '@caxri/protocol';

import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { ToggleGroup, ToggleGroupItem } from '../../components/ui/toggle-group';
import { useTranslation } from '../../i18n';
import type { UsageCustomRange } from './usage-custom-range';
import { localDateOf } from './usage-custom-range';
import { UsageRangeCalendar } from './usage-range-calendar';

const PRESET_RANGES: ReadonlyArray<Exclude<UsageRange, 'custom'>> = [
    'today',
    '7d',
    '30d',
    '90d',
    '365d',
    'all',
];

/**
 * The page header's range choice: presets apply on click, and `Custom` opens a calendar whose range applies only once
 * the user confirms it. The `Custom` item is the popover trigger, so clicking it again closes the calendar instead of
 * reopening it after the outside press already did.
 */
export function UsageRangePicker({
    custom,
    range,
    onChange,
}: {
    custom: UsageCustomRange | undefined;
    range: UsageRange;
    onChange: (range: UsageRange, custom?: UsageCustomRange) => void;
}) {
    const { t } = useTranslation();
    const [isOpen, setOpen] = useState(false);
    /**
     * Read when the calendar opens rather than during render, so the calendar's "today" is the day it was opened.
     */
    const [today, setToday] = useState('');
    return (
        <ToggleGroup
            aria-label={t('usage.filter.range')}
            value={[range]}
            onValueChange={(next: UsageRange[]) => {
                // `custom` applies through the calendar's Apply, never by pressing the item itself.
                if (next[0] && next[0] !== 'custom') onChange(next[0]);
            }}
        >
            {PRESET_RANGES.map((item) => (
                <ToggleGroupItem key={item} value={item}>
                    {t(`usage.rangeShort.${item}`)}
                </ToggleGroupItem>
            ))}
            <Popover
                open={isOpen}
                onOpenChange={(open) => {
                    if (open) setToday(localDateOf(Date.now()));
                    setOpen(open);
                }}
            >
                <PopoverTrigger render={<ToggleGroupItem value="custom" />} nativeButton>
                    {t('usage.rangeShort.custom')}
                </PopoverTrigger>
                <PopoverContent align="end" className="w-64">
                    <UsageRangeCalendar
                        initial={custom}
                        today={today}
                        onApply={(next) => {
                            onChange('custom', next);
                            setOpen(false);
                        }}
                    />
                </PopoverContent>
            </Popover>
        </ToggleGroup>
    );
}
