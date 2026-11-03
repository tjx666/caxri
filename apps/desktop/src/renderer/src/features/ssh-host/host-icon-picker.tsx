import type { HostIcon, HostIconName } from '@caxri/protocol';
import { projectIconColors } from '@caxri/protocol';
import { ChevronDown } from 'lucide-react';

import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import type { HostDisplay } from '../../stores/host-preferences';
import { projectIconColorPresentation } from '../primary-sidebar/project-icon-registry';
import { HostGlyph } from './host-glyph';
import { hostIconLabel, hostIconSections } from './host-icon-registry';

const CHOICE_CLASS =
    'cursor-pointer rounded border border-border bg-transparent text-muted hover:bg-elevated hover:text-foreground focus-visible:border-accent focus-visible:outline-none';
const CHOSEN_CLASS = 'border-accent bg-elevated text-foreground';

/**
 * Settings › Hosts' Icon column: a select-style trigger opening the icon grid and palette. A choice applies at once,
 * like every Settings control. Auto (no chosen icon) follows the detected system and keeps the name beside the glyph in
 * the side bar; only a chosen icon makes the side bar show the glyph alone.
 */
export function HostIconPicker({
    host,
    onChange,
}: {
    host: HostDisplay;
    onChange: (icon: HostIcon | null) => void;
}) {
    const { t } = useTranslation();
    const color = host.icon?.color;
    const detected = host.system && hostIconLabel(host.system, t);
    const pick = (name: HostIconName) => onChange({ name, ...(color && { color }) });
    return (
        <Popover>
            <PopoverTrigger
                aria-label={t('sshHost.settings.iconFor', { name: host.name })}
                className="flex h-8 w-full items-center justify-between gap-2 rounded-md border border-border bg-background px-2 text-[12px] outline-none focus-visible:border-accent"
            >
                <span className="flex min-w-0 items-center gap-2">
                    <HostGlyph icon={host.icon} size={14} system={host.system} />
                    {host.icon ? (
                        <span className="min-w-0 truncate">{hostIconLabel(host.icon.name, t)}</span>
                    ) : (
                        <span className="min-w-0 truncate">
                            {t('sshHost.icon.auto')}
                            <span className="text-muted">
                                {' · '}
                                {detected ?? t('sshHost.icon.notDetected')}
                            </span>
                        </span>
                    )}
                </span>
                <ChevronDown aria-hidden="true" className="flex-none" size={14} />
            </PopoverTrigger>
            <PopoverContent
                aria-label={t('sshHost.settings.iconFor', { name: host.name })}
                className="w-72 p-3"
            >
                <button
                    type="button"
                    aria-pressed={!host.icon}
                    className={cn(
                        CHOICE_CLASS,
                        'mb-3 flex w-full items-center gap-2 px-2 py-1.5 text-left',
                        !host.icon && CHOSEN_CLASS,
                    )}
                    onClick={() => onChange(null)}
                >
                    <HostGlyph size={16} system={host.system} />
                    <span className="min-w-0 flex-1">
                        <span className="block text-[12px] text-foreground">
                            {t('sshHost.icon.auto')}
                        </span>
                        <span className="block truncate text-[11px] text-muted">
                            {detected
                                ? t('sshHost.icon.detected', { system: detected })
                                : t('sshHost.icon.detectedLater')}
                        </span>
                    </span>
                </button>
                {hostIconSections.map((section, index) => (
                    <fieldset
                        key={section.titleKey}
                        className={cn('m-0 min-w-0 border-0 p-0', index > 0 && 'mt-3')}
                    >
                        <legend className="mb-2 p-0 text-[11px] font-semibold">
                            {t(section.titleKey)}
                        </legend>
                        <div className="grid grid-cols-4 gap-2">
                            {section.icons.map((name) => {
                                const label = hostIconLabel(name, t);
                                return (
                                    <button
                                        key={name}
                                        type="button"
                                        aria-label={label}
                                        aria-pressed={host.icon?.name === name}
                                        className={cn(
                                            CHOICE_CLASS,
                                            'grid min-h-14 place-items-center gap-1 p-2 text-[11px]',
                                            host.icon?.name === name && CHOSEN_CLASS,
                                        )}
                                        onClick={() => pick(name)}
                                    >
                                        <HostGlyph
                                            icon={{ name, ...(color && { color }) }}
                                            size={16}
                                        />
                                        <span className="max-w-full truncate">{label}</span>
                                    </button>
                                );
                            })}
                        </div>
                    </fieldset>
                ))}
                <div className="mt-3 mb-2 text-[11px] font-semibold">{t('sshHost.icon.color')}</div>
                <div className="flex flex-wrap gap-1.5">
                    {[undefined, ...projectIconColors].map((key) => {
                        const label = key
                            ? t('sshHost.icon.colorAriaLabel', {
                                  color: t(projectIconColorPresentation[key].labelKey),
                              })
                            : t('sshHost.icon.defaultColor');
                        return (
                            <Tooltip key={key ?? 'default'} content={label}>
                                <button
                                    type="button"
                                    aria-label={label}
                                    aria-pressed={color === key}
                                    disabled={!host.icon}
                                    className={cn(
                                        CHOICE_CLASS,
                                        'grid size-7 place-items-center disabled:cursor-not-allowed disabled:opacity-50',
                                        color === key && CHOSEN_CLASS,
                                    )}
                                    onClick={() =>
                                        host.icon &&
                                        onChange({
                                            name: host.icon.name,
                                            ...(key && { color: key }),
                                        })
                                    }
                                >
                                    <span
                                        className={cn(
                                            'size-3 rounded-full border border-border',
                                            key
                                                ? projectIconColorPresentation[key].swatchClassName
                                                : 'bg-foreground',
                                        )}
                                    />
                                </button>
                            </Tooltip>
                        );
                    })}
                </div>
            </PopoverContent>
        </Popover>
    );
}
