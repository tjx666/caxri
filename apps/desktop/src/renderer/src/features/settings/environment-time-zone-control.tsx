import { useState } from 'react';

import { Check, ChevronDown } from 'lucide-react';

import {
    Command,
    CommandEmpty,
    CommandInput,
    CommandItem,
    CommandList,
} from '../../components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { environmentTimeZones } from './environment-time-zones';
import { SHORT_CONTROL_WIDTH_CLASS_NAME } from './setting-row-layout';

interface EnvironmentTimeZoneControlProperties {
    id: string;
    label: string;
    value: string | null;
    onChange: (value: string | null) => void;
}

const timeZones = environmentTimeZones();

export function EnvironmentTimeZoneControl({
    id,
    label,
    value,
    onChange,
}: EnvironmentTimeZoneControlProperties) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger
                id={id}
                aria-label={label}
                className={cn(
                    SHORT_CONTROL_WIDTH_CLASS_NAME,
                    'flex h-9 flex-none items-center justify-between gap-2 rounded-lg border border-border bg-background px-2 text-[13px] outline-none focus-visible:border-accent focus-visible:shadow-[0_0_0_3px_var(--state-focus-ring)]',
                )}
            >
                <span className="min-w-0 truncate">
                    {value ?? t('settings.environmentMonitor.timeZone.off')}
                </span>
                <ChevronDown aria-hidden="true" className="flex-none" size={14} />
            </PopoverTrigger>
            <PopoverContent className="w-72" align="end">
                <Command label={t('settings.environmentMonitor.timeZone.searchLabel')}>
                    <CommandInput
                        autoFocus
                        placeholder={t('settings.environmentMonitor.timeZone.searchPlaceholder')}
                    />
                    <CommandList className="max-h-[min(360px,var(--available-height))]">
                        <CommandEmpty>
                            {t('settings.environmentMonitor.timeZone.empty')}
                        </CommandEmpty>
                        <CommandItem
                            value={t('settings.environmentMonitor.timeZone.off')}
                            onSelect={() => {
                                onChange(null);
                                setOpen(false);
                            }}
                        >
                            <Check
                                aria-hidden="true"
                                className={cn('flex-none', value !== null && 'invisible')}
                                size={13}
                            />
                            {t('settings.environmentMonitor.timeZone.off')}
                        </CommandItem>
                        {timeZones.map((timeZone) => (
                            <CommandItem
                                key={timeZone}
                                value={timeZone}
                                onSelect={() => {
                                    onChange(timeZone);
                                    setOpen(false);
                                }}
                            >
                                <Check
                                    aria-hidden="true"
                                    className={cn('flex-none', value !== timeZone && 'invisible')}
                                    size={13}
                                />
                                {timeZone}
                            </CommandItem>
                        ))}
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
}
