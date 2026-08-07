import { LoaderCircle, Search } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';

import { editorModelPath } from '@shared/editor-state';
import type { FileSearchMatch, FileSearchMode } from '@shared/types';

import { cn } from '../../../../lib/utils';
import { useCaxriQuery } from '../../../../queries/client';
import { openFile } from '../../../editor/document-actions';
import { revealEditorMatch } from '../../../editor/editor-reveal';

const optionClassName =
    'h-6 min-w-6 px-1 border border-border rounded bg-transparent text-muted text-[11px] cursor-pointer hover:text-foreground aria-pressed:bg-elevated aria-pressed:text-foreground';

function useDebouncedValue(value: string, delayMs: number): string {
    const [debounced, setDebounced] = useState(value);
    useEffect(() => {
        const timer = window.setTimeout(() => setDebounced(value), delayMs);
        return () => window.clearTimeout(timer);
    }, [delayMs, value]);
    return debounced;
}

function groupMatches(matches: readonly FileSearchMatch[]): Map<string, FileSearchMatch[]> {
    const groups = new Map<string, FileSearchMatch[]>();
    for (const match of matches) {
        const group = groups.get(match.relativePath);
        if (group) group.push(match);
        else groups.set(match.relativePath, [match]);
    }
    return groups;
}

async function openSearchMatch(
    sessionId: string,
    match: FileSearchMatch,
    preview = true,
): Promise<void> {
    const opened = await openFile(match.path, { preview });
    if (!opened || match.line === undefined || match.column === undefined) return;
    revealEditorMatch(editorModelPath(sessionId, match.path), {
        line: match.line,
        column: match.column,
        matchLength: match.matchLength ?? 0,
    });
}

function ResultRow({ match, sessionId }: { match: FileSearchMatch; sessionId: string }) {
    return (
        <button
            type="button"
            className="search-result flex min-h-7 w-full items-start gap-2 border-0 bg-transparent py-1 pr-2 pl-5 text-left text-foreground cursor-pointer hover:bg-elevated"
            title={match.path}
            onClick={() => void openSearchMatch(sessionId, match)}
            onDoubleClick={() => void openSearchMatch(sessionId, match, false)}
        >
            {match.line === undefined ? (
                <span className="truncate">{match.relativePath}</span>
            ) : (
                <>
                    <span className="w-8 shrink-0 text-right text-muted">{match.line}</span>
                    <span className="truncate font-mono text-[11px]">{match.preview}</span>
                </>
            )}
        </button>
    );
}

export function ProjectSearch({ sessionId, children }: { sessionId: string; children: ReactNode }) {
    const [query, setQuery] = useState('');
    const [mode, setMode] = useState<FileSearchMode>('name');
    const [caseSensitive, setCaseSensitive] = useState(false);
    const [wholeWord, setWholeWord] = useState(false);
    const [regex, setRegex] = useState(false);
    const [include, setInclude] = useState('');
    const [exclude, setExclude] = useState('');
    const debouncedQuery = useDebouncedValue(query, 150);
    const active = query.length > 0;
    const settled = query === debouncedQuery;
    const result = useCaxriQuery(
        'files.search',
        {
            sessionId,
            mode,
            query: debouncedQuery || ' ',
            caseSensitive: mode === 'content' && caseSensitive,
            wholeWord: mode === 'content' && wholeWord,
            regex: mode === 'content' && regex,
            include,
            exclude,
        },
        { enabled: debouncedQuery.length > 0 },
    );
    const groups = useMemo(() => groupMatches(result.data?.matches ?? []), [result.data?.matches]);

    return (
        <div className="project-search flex min-h-0 flex-1 flex-col">
            <div className="search-controls flex flex-col gap-1.5 border-b border-border p-2">
                <label className="flex h-7 items-center gap-1.5 rounded border border-border bg-background px-2 focus-within:border-accent">
                    <Search size={13} className="shrink-0 text-muted" />
                    <input
                        className="min-w-0 flex-1 border-0 bg-transparent p-0 text-foreground outline-none placeholder:text-muted"
                        aria-label="Search Project files"
                        placeholder="Search files"
                        value={query}
                        onChange={(event) => setQuery(event.currentTarget.value)}
                    />
                    {(result.isFetching || (active && !settled)) && (
                        <LoaderCircle size={13} className="animate-spin text-muted" />
                    )}
                </label>
                <div className="flex items-center gap-1">
                    {(['name', 'content'] as const).map((value) => (
                        <button
                            key={value}
                            type="button"
                            className={cn(optionClassName, 'capitalize')}
                            aria-pressed={mode === value}
                            onClick={() => setMode(value)}
                        >
                            {value}
                        </button>
                    ))}
                    {mode === 'content' && (
                        <div className="ml-auto flex items-center gap-1">
                            <button
                                type="button"
                                className={optionClassName}
                                aria-label="Match Case"
                                aria-pressed={caseSensitive}
                                title="Match Case"
                                onClick={() => setCaseSensitive((value) => !value)}
                            >
                                Aa
                            </button>
                            <button
                                type="button"
                                className={optionClassName}
                                aria-label="Match Whole Word"
                                aria-pressed={wholeWord}
                                title="Match Whole Word"
                                onClick={() => setWholeWord((value) => !value)}
                            >
                                ab
                            </button>
                            <button
                                type="button"
                                className={optionClassName}
                                aria-label="Use Regular Expression"
                                aria-pressed={regex}
                                title="Use Regular Expression"
                                onClick={() => setRegex((value) => !value)}
                            >
                                .*
                            </button>
                        </div>
                    )}
                </div>
                {mode === 'content' && (
                    <div className="grid grid-cols-2 gap-1">
                        <input
                            className="h-6 min-w-0 rounded border border-border bg-background px-1.5 text-[11px] text-foreground outline-none focus:border-accent"
                            aria-label="Files to include"
                            placeholder="Include"
                            value={include}
                            onChange={(event) => setInclude(event.currentTarget.value)}
                        />
                        <input
                            className="h-6 min-w-0 rounded border border-border bg-background px-1.5 text-[11px] text-foreground outline-none focus:border-accent"
                            aria-label="Files to exclude"
                            placeholder="Exclude"
                            value={exclude}
                            onChange={(event) => setExclude(event.currentTarget.value)}
                        />
                    </div>
                )}
            </div>
            {!active ? (
                <div className="min-h-0 flex-1 overflow-auto">{children}</div>
            ) : !settled ? (
                <div className="p-3 text-center text-muted">Searching…</div>
            ) : result.isError ? (
                <div className="p-3 text-center text-danger" role="alert">
                    Search failed.
                </div>
            ) : !result.isFetching && result.data?.matches.length === 0 ? (
                <div className="p-3 text-center text-muted">No results.</div>
            ) : (
                <div className="search-results min-h-0 flex-1 overflow-auto">
                    {mode === 'name'
                        ? result.data?.matches.map((match) => (
                              <ResultRow
                                  key={match.relativePath}
                                  match={match}
                                  sessionId={sessionId}
                              />
                          ))
                        : [...groups].map(([relativePath, matches]) => (
                              <div className="search-result-group" key={relativePath}>
                                  <div
                                      className="sticky top-0 z-1 flex h-7 items-center gap-1 border-b border-border bg-surface px-2 text-[11px] font-medium"
                                      title={matches[0].path}
                                  >
                                      <span className="truncate">{relativePath}</span>
                                      <span className="ml-auto text-muted">{matches.length}</span>
                                  </div>
                                  {matches.map((match) => (
                                      <ResultRow
                                          key={`${match.line}:${match.column}`}
                                          match={match}
                                          sessionId={sessionId}
                                      />
                                  ))}
                              </div>
                          ))}
                    {result.data?.truncated && (
                        <div className="border-t border-border p-2 text-center text-[11px] text-warning">
                            Results truncated by safety limits.
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
