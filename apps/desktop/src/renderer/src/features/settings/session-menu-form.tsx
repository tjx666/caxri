import type { KeyboardEvent } from 'react';
import { useState } from 'react';

import type { SessionMenuLayout } from '@caxri/protocol';
import { normalizeSessionMenuLayout, SESSION_MENU_SEPARATOR } from '@caxri/protocol';
import { GripVertical, SeparatorHorizontal, X } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Switch } from '../../components/ui/switch';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { useSessionMenuDrag } from './hooks/use-session-menu-drag';
import { sessionMenuItemLabels } from './session-menu-item-labels';
import {
    canInsertSessionMenuSeparator,
    insertSessionMenuSeparator,
    moveSessionMenuEntry,
    moveSessionMenuEntryBy,
    removeSessionMenuSeparator,
    toggleSessionMenuItemHidden,
    toStoredSessionMenuLayout,
} from './session-menu-layout-editing';

interface SessionMenuFormProperties {
    value: SessionMenuLayout | null;
    onChange: (value: SessionMenuLayout | null) => void;
}

/**
 * Settings editor for `primarySidebar.sessionMenu`: one row per menu slot or separator, reordered by dragging or
 * `Option+Up` / `Option+Down`, with a switch to show or hide each action. The order stays exactly as the user leaves
 * it; nothing reorders by usage, so the menu keeps its muscle memory.
 */
export function SessionMenuForm({ value, onChange }: SessionMenuFormProperties) {
    const { t } = useTranslation();
    const layout = normalizeSessionMenuLayout(value);
    const hiddenItems = new Set(layout.hidden);
    const [announcement, setAnnouncement] = useState('');
    const commit = (next: SessionMenuLayout): void => onChange(toStoredSessionMenuLayout(next));
    const drag = useSessionMenuDrag((from, to) => commit(moveSessionMenuEntry(layout, from, to)));
    const labelAt = (index: number): string => {
        const entry = layout.order[index];
        return t(
            entry === SESSION_MENU_SEPARATOR
                ? 'settings.sessionMenuForm.separator'
                : sessionMenuItemLabels[entry],
        );
    };
    const moveByKey = (event: KeyboardEvent<HTMLLIElement>, index: number): void => {
        if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
        event.preventDefault();
        const delta = event.key === 'ArrowUp' ? -1 : 1;
        const next = moveSessionMenuEntryBy(layout, index, delta);
        if (next === layout) return;
        commit(next);
        setAnnouncement(
            t('settings.sessionMenuForm.moved', {
                item: labelAt(index),
                position: index + delta + 1,
            }),
        );
    };

    return (
        <section aria-label={t('settings.sessionMenuForm.ariaLabel')}>
            <ul
                aria-label={t('settings.sessionMenuForm.listLabel')}
                className="relative space-y-px"
            >
                {layout.order.map((entry, index) => {
                    const isSeparator = entry === SESSION_MENU_SEPARATOR;
                    const label = labelAt(index);
                    const isHidden = !isSeparator && hiddenItems.has(entry);
                    return (
                        <li
                            // A normalized separator never leads or repeats, so the item above it names it; items keep
                            // their own key so a keyboard move keeps focus on the row that moved.
                            key={isSeparator ? `separator-after-${layout.order[index - 1]}` : entry}
                            {...drag.rowProps(index)}
                            aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                            aria-label={label}
                            className={cn(
                                'group/menu-item focus-visible:ring-ring relative flex min-h-8 cursor-grab items-center gap-2 rounded px-1 outline-none focus-visible:ring-1',
                                drag.draggingIndex === index && 'opacity-40',
                            )}
                            tabIndex={0}
                            onKeyDown={(event) => moveByKey(event, index)}
                        >
                            {drag.dropIndex === index && <InsertionLine edge="top" />}
                            {drag.dropIndex === index + 1 && index === layout.order.length - 1 && (
                                <InsertionLine edge="bottom" />
                            )}
                            <GripVertical aria-hidden className="shrink-0 text-muted" size={13} />
                            {isSeparator ? (
                                <>
                                    <span className="h-px flex-1 bg-border" />
                                    <Tooltip
                                        content={t('settings.sessionMenuForm.removeSeparator')}
                                    >
                                        <Button
                                            aria-label={t(
                                                'settings.sessionMenuForm.removeSeparator',
                                            )}
                                            className="opacity-0 group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100"
                                            size="icon"
                                            variant="ghost"
                                            onClick={() =>
                                                commit(removeSessionMenuSeparator(layout, index))
                                            }
                                        >
                                            <X size={13} />
                                        </Button>
                                    </Tooltip>
                                </>
                            ) : (
                                <>
                                    <span
                                        className={cn(
                                            'min-w-0 flex-1 truncate text-[13px]',
                                            isHidden ? 'text-muted' : 'text-foreground',
                                        )}
                                    >
                                        {label}
                                    </span>
                                    {canInsertSessionMenuSeparator(layout, index) && (
                                        <Tooltip
                                            content={t('settings.sessionMenuForm.insertSeparator')}
                                        >
                                            <Button
                                                aria-label={t(
                                                    'settings.sessionMenuForm.insertSeparatorBelow',
                                                    { item: label },
                                                )}
                                                className="opacity-0 group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100"
                                                size="icon"
                                                variant="ghost"
                                                onClick={() =>
                                                    commit(
                                                        insertSessionMenuSeparator(layout, index),
                                                    )
                                                }
                                            >
                                                <SeparatorHorizontal size={13} />
                                            </Button>
                                        </Tooltip>
                                    )}
                                    <Switch
                                        aria-label={t('settings.sessionMenuForm.show', {
                                            item: label,
                                        })}
                                        checked={!isHidden}
                                        onCheckedChange={() =>
                                            commit(toggleSessionMenuItemHidden(layout, entry))
                                        }
                                    />
                                </>
                            )}
                        </li>
                    );
                })}
            </ul>
            <p aria-live="polite" className="sr-only">
                {announcement}
            </p>
        </section>
    );
}

/**
 * The 2px `--accent` drop line with its circular leading cap, as the PrimarySidebar's Project and Session drags draw
 * it.
 */
function InsertionLine({ edge }: { edge: 'top' | 'bottom' }) {
    return (
        <span
            aria-hidden
            className={cn(
                'pointer-events-none absolute inset-x-0 z-10 h-0.5 bg-accent',
                edge === 'top' ? '-top-px' : '-bottom-px',
            )}
        >
            <span className="absolute top-1/2 -left-0.5 size-1.5 -translate-y-1/2 rounded-full bg-accent" />
        </span>
    );
}
