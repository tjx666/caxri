import type { KeyboardEvent, ReactNode } from 'react';
import { useRef } from 'react';

import { ChevronDown, ChevronUp, X } from 'lucide-react';

import { useFocusOnRevision } from '@/hooks/use-focus-on-revision';

import { useTranslation } from '../i18n';
import { isImeComposing } from '../lib/ime';
import { cn } from '../lib/utilities';
import { Input, InputGroup } from './ui/input';
import { Tooltip } from './ui/tooltip';

const ACTION_CLASS_NAME =
    'grid size-6 shrink-0 place-items-center rounded border-0 bg-transparent p-0 text-muted cursor-pointer hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-45';

interface FindBarProperties {
    /**
     * The `search` landmark's name, which also names the surface the bar searches.
     */
    ariaLabel: string;
    /**
     * Positioning extras on top of the shared top-right placement, such as the stacking order over the surface.
     */
    className?: string;
    /**
     * `3/12`, a no-match or error message, or empty before a query is typed.
     */
    countLabel: string;
    focusRevision: number;
    /**
     * Whether there is a match to step to; the previous and next buttons are disabled otherwise.
     */
    hasMatches: boolean;
    inputLabel: string;
    /**
     * Docks the bar in its own strip at the top of a flex column instead of floating it over the surface, so it never
     * covers the text it searches. The Chat docks it; the Terminal keeps it floating over a fixed-size grid.
     */
    isDocked?: boolean;
    /**
     * The query has no match or cannot be searched, which shows the count in the danger tone.
     */
    isNoMatch: boolean;
    /**
     * The query itself is invalid (a malformed regular expression), reported on the input.
     */
    isQueryInvalid?: boolean;
    /**
     * Toggles shown inside the input group after the query, such as the Terminal's Match Case/Whole Word/Regex.
     */
    options?: ReactNode;
    query: string;
    onClose: () => void;
    /**
     * Key handling for the whole bar, so option chords work while a button owns focus too.
     */
    onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
    onNext: () => void;
    onPrevious: () => void;
    onQueryChange: (query: string) => void;
}

/**
 * The find bar a Terminal and a Chat open from the same `terminal.find` command, at the top right of the surface. Enter
 * and Shift+Enter step through matches and Escape closes, which the buttons' tooltips name; none of them act while an
 * IME is composing, where Enter commits the composition and Escape cancels it.
 */
export function FindBar({
    ariaLabel,
    className,
    countLabel,
    focusRevision,
    hasMatches,
    inputLabel,
    isDocked = false,
    isNoMatch,
    isQueryInvalid = false,
    options,
    query,
    onClose,
    onKeyDown,
    onNext,
    onPrevious,
    onQueryChange,
}: FindBarProperties) {
    const { t } = useTranslation();
    const inputReference = useRef<HTMLInputElement>(null);
    useFocusOnRevision(focusRevision, inputReference, { select: true });
    const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
        if (isImeComposing(event)) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
            return;
        }
        if (event.key !== 'Enter') return;
        event.preventDefault();
        if (event.shiftKey) onPrevious();
        else onNext();
    };
    const bar = (
        <search
            aria-label={ariaLabel}
            className={cn(
                'flex items-center gap-1 rounded border border-border bg-surface p-1',
                isDocked
                    ? 'max-w-full'
                    : 'absolute top-2 right-2 max-w-[calc(100%-1rem)] shadow-lg',
                className,
            )}
            onKeyDown={onKeyDown}
        >
            <InputGroup appearance="workbench" className="w-56" size="dense">
                <Input
                    ref={inputReference}
                    appearance="embedded"
                    aria-invalid={isQueryInvalid}
                    aria-label={inputLabel}
                    className="flex-1 text-foreground"
                    placeholder={t('core.findBar.placeholder')}
                    size="dense"
                    spellCheck={false}
                    value={query}
                    onChange={(event) => onQueryChange(event.currentTarget.value)}
                    onKeyDown={handleInputKeyDown}
                />
                {options}
            </InputGroup>
            <span
                aria-live="polite"
                className={cn(
                    'min-w-14 text-center text-[11px] tabular-nums',
                    isNoMatch ? 'text-danger' : 'text-muted',
                )}
            >
                {countLabel}
            </span>
            <Tooltip content={t('core.findBar.previousMatch')} shortcut="shift+enter">
                <button
                    aria-label={t('core.findBar.previousMatch')}
                    className={ACTION_CLASS_NAME}
                    disabled={!hasMatches}
                    type="button"
                    onClick={onPrevious}
                >
                    <ChevronUp size={14} />
                </button>
            </Tooltip>
            <Tooltip content={t('core.findBar.nextMatch')} shortcut="enter">
                <button
                    aria-label={t('core.findBar.nextMatch')}
                    className={ACTION_CLASS_NAME}
                    disabled={!hasMatches}
                    type="button"
                    onClick={onNext}
                >
                    <ChevronDown size={14} />
                </button>
            </Tooltip>
            <Tooltip content={t('core.findBar.close')} shortcut="escape">
                <button
                    aria-label={t('core.findBar.close')}
                    className={ACTION_CLASS_NAME}
                    type="button"
                    onClick={onClose}
                >
                    <X size={14} />
                </button>
            </Tooltip>
        </search>
    );
    return isDocked ? <div className="flex shrink-0 justify-end px-2 pt-2">{bar}</div> : bar;
}
