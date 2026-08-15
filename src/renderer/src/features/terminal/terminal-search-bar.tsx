import type { KeyboardEvent } from 'react';
import { useEffect, useRef } from 'react';

import { ChevronDown, ChevronUp, X } from 'lucide-react';

import { Input, InputGroup } from '../../components/ui/input';
import { Tooltip } from '../../components/ui/tooltip';
import { keyboardEventShortcut } from '../../lib/keybindings';
import type { TerminalSearchOptions, TerminalSearchResults } from './terminal-search';
import { terminalSearchResultLabel } from './terminal-search';

/**
 * VS Code's Match Case/Whole Word/Regex chords, mapped to the toggle each fires. Resolved through
 * `keyboardEventShortcut`, which reads `event.code` rather than `event.key`, so Option+letter works
 * on macOS: the OS composes those into an accented character, so matching on `event.key` would see
 * "ç" for Option+C and type it into the Find input instead of toggling Match Case.
 */
const SEARCH_TOGGLE_SHORTCUTS: Record<string, keyof TerminalSearchOptions> = {
    'alt+c': 'caseSensitive',
    'alt+r': 'regex',
    'alt+w': 'wholeWord',
};

const searchActionClassName =
    'grid size-6 shrink-0 place-items-center rounded border-0 bg-transparent p-0 text-muted text-[11px] cursor-pointer hover:bg-elevated hover:text-foreground aria-pressed:bg-elevated aria-pressed:text-foreground disabled:cursor-default disabled:opacity-45';

interface TerminalSearchBarProperties extends TerminalSearchOptions {
    focusRevision: number;
    query: string;
    results: TerminalSearchResults;
    onClose: () => void;
    onNavigate: (direction: 'next' | 'previous') => void;
    onQueryChange: (query: string) => void;
    onToggle: (option: keyof TerminalSearchOptions) => void;
}

export function TerminalSearchBar({
    caseSensitive,
    focusRevision,
    query,
    regex,
    results,
    wholeWord,
    onClose,
    onNavigate,
    onQueryChange,
    onToggle,
}: TerminalSearchBarProperties) {
    const inputReference = useRef<HTMLInputElement>(null);
    const resultLabel = terminalSearchResultLabel(query, results);

    useEffect(() => {
        const frame = requestAnimationFrame(() => {
            inputReference.current?.focus();
            inputReference.current?.select();
        });
        return () => cancelAnimationFrame(frame);
    }, [focusRevision]);

    const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
        if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
            return;
        }
        if (event.key !== 'Enter') return;
        event.preventDefault();
        onNavigate(event.shiftKey ? 'previous' : 'next');
    };

    /**
     * Listens at the search bar root (not just the input) so the chords work while a toggle button
     *  or a navigation button owns focus too, not only while typing a query.
     */
    const handleSearchBarKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
        const option = SEARCH_TOGGLE_SHORTCUTS[keyboardEventShortcut(event.nativeEvent)];
        if (!option) return;
        event.preventDefault();
        onToggle(option);
    };

    return (
        <search
            aria-label="Terminal buffer search"
            className="terminal-search absolute top-2 right-2 z-[4] flex max-w-[calc(100%-1rem)] items-center gap-1 rounded border border-border bg-surface p-1 shadow-lg"
            onKeyDown={handleSearchBarKeyDown}
        >
            <InputGroup appearance="workbench" className="w-56" size="dense">
                <Input
                    ref={inputReference}
                    appearance="embedded"
                    aria-invalid={Boolean(results.error)}
                    aria-label="Find in Terminal"
                    className="flex-1 text-foreground"
                    placeholder="Find"
                    size="dense"
                    value={query}
                    onChange={(event) => onQueryChange(event.currentTarget.value)}
                    onKeyDown={handleKeyDown}
                />
                <Tooltip content="Match Case">
                    <button
                        aria-label="Match Case"
                        aria-pressed={caseSensitive}
                        className={searchActionClassName}
                        type="button"
                        onClick={() => onToggle('caseSensitive')}
                    >
                        Aa
                    </button>
                </Tooltip>
                <Tooltip content="Match Whole Word">
                    <button
                        aria-label="Match Whole Word"
                        aria-pressed={wholeWord}
                        className={searchActionClassName}
                        type="button"
                        onClick={() => onToggle('wholeWord')}
                    >
                        ab
                    </button>
                </Tooltip>
                <Tooltip content="Use Regular Expression">
                    <button
                        aria-label="Use Regular Expression"
                        aria-pressed={regex}
                        className={searchActionClassName}
                        type="button"
                        onClick={() => onToggle('regex')}
                    >
                        .*
                    </button>
                </Tooltip>
            </InputGroup>
            <span
                aria-live="polite"
                className="min-w-14 text-center text-[11px] text-muted"
                data-search-count={results.resultCount}
            >
                {resultLabel}
            </span>
            <Tooltip content="Previous Match">
                <button
                    aria-label="Previous Terminal search result"
                    className={searchActionClassName}
                    disabled={!query || Boolean(results.error)}
                    type="button"
                    onClick={() => onNavigate('previous')}
                >
                    <ChevronUp size={14} />
                </button>
            </Tooltip>
            <Tooltip content="Next Match">
                <button
                    aria-label="Next Terminal search result"
                    className={searchActionClassName}
                    disabled={!query || Boolean(results.error)}
                    type="button"
                    onClick={() => onNavigate('next')}
                >
                    <ChevronDown size={14} />
                </button>
            </Tooltip>
            <Tooltip content="Close Search">
                <button
                    aria-label="Close Terminal search"
                    className={searchActionClassName}
                    type="button"
                    onClick={onClose}
                >
                    <X size={14} />
                </button>
            </Tooltip>
        </search>
    );
}
