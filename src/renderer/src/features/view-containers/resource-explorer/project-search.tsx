import { useMemo, useRef, useState } from 'react';

import { editorModelPath } from '@shared/editor-state';
import type { FileSearchMatch, FileSearchMode } from '@shared/types';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, ListFilter, Search, X } from 'lucide-react';

import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useFocusOnRevision } from '@/hooks/use-focus-on-revision';

import { DisclosureMotion } from '../../../components/disclosure-motion';
import { Input, InputGroup } from '../../../components/ui/input';
import { Spinner } from '../../../components/ui/spinner';
import { Tooltip } from '../../../components/ui/tooltip';
import { FileTypeIcon } from '../../../icons/files/file-type-icon';
import { cn } from '../../../lib/utilities';
import { sessionViewScope } from '../../../stores/session-view';
import { openFile } from '../../editor/document-actions';
import { revealEditorMatch } from '../../editor/editor-reveal';
import { useResourceExplorerClient } from '../controlled-view-context';
import { projectSearchQueryKey } from './project-search-query';
import type { NameSearchNode } from './project-search-tree';
import { buildNameSearchTree, groupSearchMatches } from './project-search-tree';

const searchOptionClassName =
    'grid size-6 shrink-0 place-items-center rounded border-0 bg-transparent p-0 text-muted text-[11px] cursor-pointer hover:bg-elevated hover:text-foreground aria-pressed:bg-elevated aria-pressed:text-foreground';

/**
 * `openSearchMatch` funnels its own failures through `openFile`'s `tryCommand` wrapper, so callers below intentionally
 * discard the returned promise instead of awaiting it.
 */
function discard(promise: Promise<unknown>): void {
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void promise;
}

async function openSearchMatch(
    sessionId: string,
    match: FileSearchMatch,
    isPreview = true,
): Promise<void> {
    const opened = await openFile(match.path, { preview: isPreview });
    if (!opened || match.line === undefined || match.column === undefined) return;
    revealEditorMatch(editorModelPath(sessionViewScope(sessionId), match.path), {
        line: match.line,
        column: match.column,
        matchLength: match.matchLength ?? 0,
    });
}

function NameSearchTreeNode({
    depth,
    node,
    sessionId,
}: {
    depth: number;
    node: NameSearchNode;
    sessionId: string;
}) {
    const [expanded, setExpanded] = useState(true);
    if (node.kind === 'directory')
        return (
            <div>
                <button
                    type="button"
                    className="search-tree-folder flex h-7 w-full cursor-pointer items-center gap-1.5 border-0 bg-transparent pr-2 text-left text-foreground hover:bg-elevated"
                    style={{ paddingLeft: 8 + depth * 12 }}
                    title={node.relativePath}
                    aria-expanded={expanded}
                    onClick={() => setExpanded((value) => !value)}
                >
                    {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    <FileTypeIcon
                        entry={{ kind: 'directory', name: node.name }}
                        expanded={expanded}
                    />
                    <span className="truncate">{node.name}</span>
                </button>
                <DisclosureMotion animate expanded={expanded} kind="files-name-group">
                    {() =>
                        node.children.map((child) => (
                            <NameSearchTreeNode
                                key={child.relativePath}
                                depth={depth + 1}
                                node={child}
                                sessionId={sessionId}
                            />
                        ))
                    }
                </DisclosureMotion>
            </div>
        );
    return (
        <button
            type="button"
            className="search-result flex h-7 w-full cursor-pointer items-center gap-2 border-0 bg-transparent pr-2 text-left text-foreground hover:bg-elevated"
            style={{ paddingLeft: 23 + depth * 12 }}
            title={node.match.path}
            onClick={() => discard(openSearchMatch(sessionId, node.match))}
            onDoubleClick={() => discard(openSearchMatch(sessionId, node.match, false))}
        >
            <FileTypeIcon entry={{ kind: 'file', name: node.name }} />
            <span className="truncate">{node.name}</span>
        </button>
    );
}

function HighlightedPreview({ match }: { match: FileSearchMatch }) {
    const preview = match.preview ?? '';
    const start = Math.min(match.previewMatchIndex ?? 0, preview.length);
    const length = Math.min(match.matchLength ?? 0, preview.length - start);
    if (length <= 0) return preview;
    return (
        <>
            {preview.slice(0, start)}
            <mark className="rounded-sm bg-warning px-0.5 text-background">
                {preview.slice(start, start + length)}
            </mark>
            {preview.slice(start + length)}
        </>
    );
}

function ContentResultRow({ match, sessionId }: { match: FileSearchMatch; sessionId: string }) {
    return (
        <button
            type="button"
            className="search-result flex min-h-7 w-full cursor-pointer items-start gap-2 border-0 bg-transparent py-1 pr-2 pl-5 text-left text-foreground hover:bg-elevated"
            title={match.path}
            onClick={() => discard(openSearchMatch(sessionId, match))}
            onDoubleClick={() => discard(openSearchMatch(sessionId, match, false))}
        >
            <span className="w-8 shrink-0 text-right text-muted">{match.line}</span>
            <span className="truncate font-mono text-[11px]">
                <HighlightedPreview match={match} />
            </span>
        </button>
    );
}

function ContentResultGroup({
    matches,
    relativePath,
    sessionId,
}: {
    matches: FileSearchMatch[];
    relativePath: string;
    sessionId: string;
}) {
    const [expanded, setExpanded] = useState(true);
    const segments = relativePath.split('/');
    const name = segments.pop() ?? relativePath;
    const directory = segments.join('/');
    return (
        <div className="search-result-group" title={relativePath}>
            <button
                type="button"
                className="sticky top-0 z-1 flex h-7 w-full min-w-0 cursor-pointer items-center gap-1.5 border-x-0 border-t-0 border-b border-border bg-surface px-2 text-left text-[11px] font-medium text-foreground hover:bg-elevated"
                aria-expanded={expanded}
                onClick={() => setExpanded((value) => !value)}
            >
                {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <FileTypeIcon entry={{ kind: 'file', name }} />
                <span className="shrink-0">{name}</span>
                {directory && (
                    <span className="min-w-0 flex-1 truncate text-muted">{directory}</span>
                )}
                <span className="ml-auto shrink-0 text-muted">{matches.length}</span>
            </button>
            <DisclosureMotion animate expanded={expanded} kind="files-content-group">
                {() =>
                    matches.map((match) => (
                        <ContentResultRow
                            key={`${match.line}:${match.column}`}
                            match={match}
                            sessionId={sessionId}
                        />
                    ))
                }
            </DisclosureMotion>
        </div>
    );
}

export function ProjectSearch({
    focusRevision,
    sessionId,
    scopeId,
}: {
    focusRevision: number;
    sessionId: string;
    scopeId: string;
}) {
    const client = useResourceExplorerClient();
    const inputReference = useRef<HTMLInputElement>(null);
    const [query, setQuery] = useState('');
    const [mode, setMode] = useState<FileSearchMode>('name');
    const [caseSensitive, setCaseSensitive] = useState(false);
    const [wholeWord, setWholeWord] = useState(false);
    const [regex, setRegex] = useState(false);
    const [include, setInclude] = useState('');
    const [exclude, setExclude] = useState('');
    const debouncedQuery = useDebouncedValue(query, 150);
    const isActive = query.length > 0;
    const isSettled = query === debouncedQuery;
    const searchOptions = {
        mode,
        query: debouncedQuery || ' ',
        caseSensitive: mode === 'content' && caseSensitive,
        wholeWord: mode === 'content' && wholeWord,
        regex: mode === 'content' && regex,
        include,
        exclude,
    };
    const result = useQuery({
        queryKey: projectSearchQueryKey(client.viewId, searchOptions, scopeId),
        queryFn: ({ signal }) => client.search(searchOptions, signal),
        enabled: debouncedQuery.length > 0,
    });
    const groups = useMemo(
        () => groupSearchMatches(result.data?.matches ?? []),
        [result.data?.matches],
    );
    const nameTree = useMemo(
        () => buildNameSearchTree(result.data?.matches ?? []),
        [result.data?.matches],
    );
    const SearchModeIcon = mode === 'name' ? ListFilter : Search;

    /**
     * Focus after the panel commit so a Terminal attachment finishing in the same frame cannot reclaim focus from the
     * app-wide Search Files command.
     */
    useFocusOnRevision(focusRevision, inputReference);

    return (
        <div className="project-search flex min-h-0 flex-1 flex-col">
            <div className="search-controls flex flex-col gap-1.5 border-b border-border p-2">
                <InputGroup appearance="workbench" size="dense">
                    <SearchModeIcon
                        size={14}
                        className="shrink-0 text-muted"
                        data-search-mode-icon={mode}
                    />
                    <Input
                        ref={inputReference}
                        appearance="embedded"
                        className="flex-1 text-foreground"
                        aria-label={
                            mode === 'name' ? 'Find Project files' : 'Search Project contents'
                        }
                        placeholder={mode === 'name' ? 'Find files' : 'Search text'}
                        value={query}
                        onChange={(event) => setQuery(event.currentTarget.value)}
                        size="dense"
                    />
                    {(result.isFetching || (isActive && !isSettled)) && (
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
                                    aria-pressed={caseSensitive}
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
                                    aria-pressed={wholeWord}
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
                                    aria-pressed={regex}
                                    onClick={() => setRegex((value) => !value)}
                                >
                                    .*
                                </button>
                            </Tooltip>
                        </>
                    )}
                </InputGroup>
                <div className="search-mode-segments grid w-full grid-cols-2 gap-0.5 rounded-md bg-elevated p-0.5">
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
                {mode === 'content' && (
                    <div className="flex flex-col gap-1.5 pt-0.5">
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
                )}
            </div>
            {!isActive ? (
                <div className="min-h-0 flex-1" />
            ) : !isSettled ? (
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
                        ? nameTree.map((node) => (
                              <NameSearchTreeNode
                                  key={node.relativePath}
                                  depth={0}
                                  node={node}
                                  sessionId={sessionId}
                              />
                          ))
                        : [...groups].map(([relativePath, matches]) => (
                              <ContentResultGroup
                                  key={relativePath}
                                  relativePath={relativePath}
                                  matches={matches}
                                  sessionId={sessionId}
                              />
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
