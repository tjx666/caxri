import type { KeyboardEvent, RefObject } from 'react';

import { EyeOff, ListFilter, Search, X } from 'lucide-react';

import { Input, InputGroup } from '../../components/ui/input';
import { Spinner } from '../../components/ui/spinner';
import { Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/utilities';
import type { ProjectSearchModel } from './use-project-search';

const searchOptionClassName =
    'grid size-6 shrink-0 place-items-center rounded border-0 bg-transparent p-0 text-muted text-[11px] cursor-pointer hover:bg-elevated hover:text-foreground aria-pressed:bg-elevated aria-pressed:text-foreground';

interface ProjectSearchControlsProperties {
    /**
     * Names the selected result for assistive technology; the rows themselves never take focus.
     */
    activeDescendantId: string | undefined;
    inputElement: RefObject<HTMLInputElement | null>;
    onInputKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
    resultsId: string;
    search: ProjectSearchModel;
}

/**
 * The query field, the Name/Content switch, and the option toggles that only content search uses.
 */
export function ProjectSearchControls({
    activeDescendantId,
    inputElement,
    onInputKeyDown,
    resultsId,
    search,
}: ProjectSearchControlsProperties) {
    const {
        displayState,
        exclude,
        include,
        isActive,
        isCaseSensitive,
        isFetching,
        isRegex,
        isSettled,
        isUsingIgnoreFiles,
        isWholeWord,
        mode,
        query,
        setCaseSensitive,
        setExclude,
        setInclude,
        setMode,
        setQuery,
        setRegex,
        setUseIgnoreFiles,
        setWholeWord,
    } = search;
    const SearchModeIcon = mode === 'name' ? ListFilter : Search;
    return (
        <div className="search-controls flex flex-none flex-col gap-1.5 border-b border-border p-2">
            <div className="flex items-center gap-1.5">
                <InputGroup appearance="workbench" size="dense" className="flex-1">
                    <SearchModeIcon
                        size={14}
                        className="shrink-0 text-muted"
                        data-search-mode-icon={mode}
                    />
                    <Input
                        autoFocus
                        ref={inputElement}
                        appearance="embedded"
                        className="flex-1 text-foreground"
                        role="combobox"
                        aria-label={
                            mode === 'name' ? 'Find Project files' : 'Search Project contents'
                        }
                        aria-autocomplete="list"
                        aria-controls={resultsId}
                        aria-expanded={displayState === 'results'}
                        /*
                         * The rows are `tabIndex={-1}` and the input never gives up focus, so this attribute is the only
                         * thing telling assistive technology which result the Up/Down keys are on.
                         */
                        aria-activedescendant={activeDescendantId}
                        placeholder={mode === 'name' ? 'Find files' : 'Search text'}
                        value={query}
                        onChange={(event) => setQuery(event.currentTarget.value)}
                        onKeyDown={onInputKeyDown}
                        size="dense"
                    />
                    {(isFetching || (isActive && !isSettled)) && (
                        <Spinner size={13} className="shrink-0 text-muted" />
                    )}
                    {isActive && (
                        <Tooltip content="Clear Search">
                            <button
                                type="button"
                                className={searchOptionClassName}
                                aria-label="Clear Project search"
                                onClick={() => setQuery('')}
                            >
                                <X size={13} />
                            </button>
                        </Tooltip>
                    )}
                    {mode === 'content' && (
                        <>
                            <Tooltip content="Match Case">
                                <button
                                    type="button"
                                    className={searchOptionClassName}
                                    aria-label="Match Case"
                                    aria-pressed={isCaseSensitive}
                                    onClick={() => setCaseSensitive((value) => !value)}
                                >
                                    Aa
                                </button>
                            </Tooltip>
                            <Tooltip content="Match Whole Word">
                                <button
                                    type="button"
                                    className={searchOptionClassName}
                                    aria-label="Match Whole Word"
                                    aria-pressed={isWholeWord}
                                    onClick={() => setWholeWord((value) => !value)}
                                >
                                    ab
                                </button>
                            </Tooltip>
                            <Tooltip content="Use Regular Expression">
                                <button
                                    type="button"
                                    className={searchOptionClassName}
                                    aria-label="Use Regular Expression"
                                    aria-pressed={isRegex}
                                    onClick={() => setRegex((value) => !value)}
                                >
                                    .*
                                </button>
                            </Tooltip>
                        </>
                    )}
                    {/*
                     * Shown in both modes, unlike the three above it: whether the Project's ignore files narrow the
                     * scan decides which files either lookup could have reached. It stays a visible toggle rather than
                     * a setting because a file skipped by `.gitignore` and a file that genuinely does not match
                     * produce the same empty list.
                     */}
                    <Tooltip
                        content={
                            isUsingIgnoreFiles
                                ? 'Using .gitignore — click to search ignored files too'
                                : 'Searching ignored files — click to apply .gitignore'
                        }
                    >
                        <button
                            type="button"
                            className={searchOptionClassName}
                            aria-label="Use Ignore Files"
                            aria-pressed={isUsingIgnoreFiles}
                            onClick={() => setUseIgnoreFiles((value) => !value)}
                        >
                            <EyeOff size={13} />
                        </button>
                    </Tooltip>
                </InputGroup>
                <div className="search-mode-segments grid w-44 flex-none grid-cols-2 gap-0.5 rounded-md bg-elevated p-0.5">
                    {(['name', 'content'] as const).map((value) => (
                        <button
                            key={value}
                            type="button"
                            className={cn(
                                'h-6 cursor-pointer rounded border-0 bg-transparent text-[12px] font-medium text-muted hover:text-foreground',
                                mode === value && 'bg-surface text-foreground shadow-sm',
                            )}
                            aria-pressed={mode === value}
                            onClick={() => setMode(value)}
                        >
                            {value === 'name' ? 'Name' : 'Content'}
                        </button>
                    ))}
                </div>
            </div>
            {/*
             * Not gated on the mode. `include` and `exclude` have always been sent for a name search too: the hook
             * withholds only the three matcher options above, so hiding the fields left Name mode quietly honouring
             * globs the user could no longer see or clear.
             */}
            <div className="grid grid-cols-2 gap-1.5">
                <label className="flex flex-col gap-1 text-[11px] text-muted">
                    <span>Files to include</span>
                    <Input
                        appearance="workbench"
                        className="text-foreground"
                        placeholder="Files to include (e.g. *.ts, src/**)"
                        size="dense"
                        value={include}
                        onChange={(event) => setInclude(event.currentTarget.value)}
                    />
                </label>
                <label className="flex flex-col gap-1 text-[11px] text-muted">
                    <span>Files to exclude</span>
                    <Input
                        appearance="workbench"
                        className="text-foreground"
                        placeholder="Files to exclude (e.g. *.min.js, dist/**)"
                        size="dense"
                        value={exclude}
                        onChange={(event) => setExclude(event.currentTarget.value)}
                    />
                </label>
            </div>
        </div>
    );
}
