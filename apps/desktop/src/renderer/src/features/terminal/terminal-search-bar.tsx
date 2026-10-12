import type { KeyboardEvent } from 'react';

import { FindBar } from '../../components/find-bar';
import { ToggleGroup, ToggleGroupItem } from '../../components/ui/toggle-group';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { keyboardEventShortcut } from '../../lib/keybindings';
import type { TerminalSearchOptions, TerminalSearchResults } from './terminal-search';
import {
    isTerminalSearchNavigable,
    isTerminalSearchNoMatch,
    terminalSearchResultLabel,
} from './terminal-search';

/**
 * VS Code's Match Case/Whole Word/Regex chords, mapped to the toggle each fires. Resolved through
 * `keyboardEventShortcut`, which reads `event.code` rather than `event.key`, so Option+letter works on macOS: the OS
 * composes those into an accented character, so matching on `event.key` would see "ç" for Option+C and type it into the
 * Find input instead of toggling Match Case.
 */
const SEARCH_TOGGLE_SHORTCUTS: Partial<Record<string, keyof TerminalSearchOptions>> = {
    'alt+c': 'caseSensitive',
    'alt+r': 'regex',
    'alt+w': 'wholeWord',
};

/**
 * `ToggleGroup`'s `value` is the array of currently-pressed item values; each search toggle maps 1:1 to a
 * `TerminalSearchOptions` key so the group's `multiple` mode can hold any combination.
 */
const SEARCH_TOGGLE_VALUES: ReadonlyArray<keyof TerminalSearchOptions> = [
    'caseSensitive',
    'wholeWord',
    'regex',
];

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
    const pressedOptions: Array<keyof TerminalSearchOptions> = [
        caseSensitive && 'caseSensitive',
        wholeWord && 'wholeWord',
        regex && 'regex',
    ].filter((value): value is keyof TerminalSearchOptions => Boolean(value));

    /**
     * `ToggleGroup` reports the full next `value` array; diff it against the current pressed set to find the single
     * option that changed and forward it through the existing `onToggle(option)` contract, keeping the keyboard-chord
     * and click paths in sync.
     */
    const handleToggleGroupChange = (nextValues: Array<keyof TerminalSearchOptions>): void => {
        const changed = SEARCH_TOGGLE_VALUES.find(
            (value) => nextValues.includes(value) !== pressedOptions.includes(value),
        );
        if (changed) onToggle(changed);
    };

    /**
     * Listens at the search bar root (not just the input) so the chords work while a toggle button or a navigation
     * button owns focus too, not only while typing a query.
     */
    const { t } = useTranslation();
    const handleSearchBarKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
        const option = SEARCH_TOGGLE_SHORTCUTS[keyboardEventShortcut(event.nativeEvent)];
        if (!option) return;
        event.preventDefault();
        onToggle(option);
    };

    return (
        <FindBar
            ariaLabel={t('terminal.search.ariaLabel')}
            className="terminal-search z-[4]"
            countLabel={terminalSearchResultLabel(t, query, results)}
            focusRevision={focusRevision}
            hasMatches={isTerminalSearchNavigable(query, results)}
            inputLabel={t('terminal.search.inputLabel')}
            isNoMatch={isTerminalSearchNoMatch(query, results)}
            isQueryInvalid={Boolean(results.error)}
            options={
                <ToggleGroup
                    aria-label={t('terminal.search.optionsLabel')}
                    multiple
                    value={pressedOptions}
                    onValueChange={handleToggleGroupChange}
                >
                    <Tooltip content={t('terminal.search.matchCase')}>
                        <ToggleGroupItem
                            aria-label={t('terminal.search.matchCase')}
                            value="caseSensitive"
                        >
                            Aa
                        </ToggleGroupItem>
                    </Tooltip>
                    <Tooltip content={t('terminal.search.wholeWord')}>
                        <ToggleGroupItem
                            aria-label={t('terminal.search.wholeWord')}
                            value="wholeWord"
                        >
                            ab
                        </ToggleGroupItem>
                    </Tooltip>
                    <Tooltip content={t('terminal.search.regex')}>
                        <ToggleGroupItem aria-label={t('terminal.search.regex')} value="regex">
                            .*
                        </ToggleGroupItem>
                    </Tooltip>
                </ToggleGroup>
            }
            query={query}
            onClose={onClose}
            onKeyDown={handleSearchBarKeyDown}
            onNext={() => onNavigate('next')}
            onPrevious={() => onNavigate('previous')}
            onQueryChange={onQueryChange}
        />
    );
}
