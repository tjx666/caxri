import { useId, useState } from 'react';

import type { FileSearchMatch, FileSearchMode } from '@caxri/protocol';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { DisclosureMotion } from '../../components/disclosure-motion';
import { GitFileStatusLetter } from '../../components/git-file-status-letter';
import { useTranslation } from '../../i18n';
import { FileTypeIcon } from '../../icons/files/file-type-icon';
import { gitDecorationClassName, gitDecorationDescription } from '../../lib/git-decorations';
import { cn } from '../../lib/utilities';
import { useGitDecoration } from '../../stores/git-decorations';
import { searchMatchKey } from './project-search-selection';
import type { NameSearchNode } from './project-search-tree';

export interface ProjectSearchResultHandlers {
    /**
     * DOM id of the row for a match, so the input can point `aria-activedescendant` at it.
     */
    rowId: (match: FileSearchMatch) => string;
    onOpen: (match: FileSearchMatch) => void;
    onSelect: (match: FileSearchMatch) => void;
    selectedKey: string | undefined;
}

/**
 * Reads the `--list-*` roles like every other picker, so one imported VS Code theme reaches this surface too. The
 * current row is painted with the focus fill rather than the selection fill: the keyboard drives it from the input.
 */
const rowClassName =
    'search-result flex w-full cursor-pointer items-center border-0 bg-transparent text-left text-foreground hover:bg-list-hover-background hover:text-list-hover-foreground aria-selected:bg-list-focus-background aria-selected:text-list-focus-foreground';

/**
 * A result row is a `treeitem` that never takes focus: the input keeps it, and `aria-activedescendant` on the input is
 * what tells assistive technology which row is current. That is the one place this tree departs from the Workbench's
 * roving-tabindex rule, and it is why the overlay can be driven entirely from the query the user is still typing.
 */
function ResultRow({
    children,
    className,
    describedById,
    handlers,
    match,
    style,
    title,
}: {
    children: React.ReactNode;
    className?: string;
    describedById?: string;
    handlers: ProjectSearchResultHandlers;
    match: FileSearchMatch;
    style?: React.CSSProperties;
    title: string;
}) {
    return (
        <button
            type="button"
            className={cn(rowClassName, className)}
            style={style}
            role="treeitem"
            aria-level={1}
            aria-selected={handlers.selectedKey === searchMatchKey(match)}
            aria-describedby={describedById}
            id={handlers.rowId(match)}
            tabIndex={-1}
            title={title}
            onClick={() => handlers.onSelect(match)}
            onDoubleClick={() => handlers.onOpen(match)}
        >
            {children}
        </button>
    );
}

/**
 * The status letter plus the sentence a screen reader hears instead of it. The letter alone is a glyph with no
 * accessible meaning, so the row points `aria-describedby` at the sentence; the id therefore has to be minted by the
 * row and handed down rather than made here.
 */
function GitDecorationSuffix({ descriptionId, path }: { descriptionId: string; path: string }) {
    const decoration = useGitDecoration(path);
    if (!decoration) return null;
    return (
        <>
            <GitFileStatusLetter decoration={decoration} />
            <span id={descriptionId} className="sr-only">
                {gitDecorationDescription(decoration.kind)}
            </span>
        </>
    );
}

function NameResultRow({
    depth,
    handlers,
    node,
}: {
    depth: number;
    handlers: ProjectSearchResultHandlers;
    node: Extract<NameSearchNode, { kind: 'file' }>;
}) {
    const decoration = useGitDecoration(node.match.path);
    const descriptionId = useId();
    return (
        <ResultRow
            className="h-7 gap-2 pr-2"
            describedById={decoration ? descriptionId : undefined}
            handlers={handlers}
            match={node.match}
            style={{ paddingLeft: 23 + depth * 12 }}
            title={node.match.relativePath}
        >
            <FileTypeIcon entry={{ kind: 'file', name: node.name }} />
            <span
                className={cn(
                    'min-w-0 flex-1 truncate',
                    decoration && gitDecorationClassName(decoration.kind),
                )}
            >
                {node.name}
            </span>
            <GitDecorationSuffix descriptionId={descriptionId} path={node.match.path} />
        </ResultRow>
    );
}

function NameResultNode({
    depth,
    handlers,
    node,
}: {
    depth: number;
    handlers: ProjectSearchResultHandlers;
    node: NameSearchNode;
}) {
    const [expanded, setExpanded] = useState(true);
    if (node.kind === 'file')
        return <NameResultRow depth={depth} handlers={handlers} node={node} />;
    return (
        <div>
            <button
                type="button"
                className="search-tree-folder flex h-7 w-full cursor-pointer items-center gap-1.5 border-0 bg-transparent pr-2 text-left text-foreground hover:bg-elevated"
                style={{ paddingLeft: 8 + depth * 12 }}
                title={node.relativePath}
                aria-expanded={expanded}
                tabIndex={-1}
                onClick={() => setExpanded((value) => !value)}
            >
                {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <FileTypeIcon entry={{ kind: 'directory', name: node.name }} expanded={expanded} />
                <span className="truncate">{node.name}</span>
            </button>
            <DisclosureMotion animate expanded={expanded} kind="files-name-group">
                {() =>
                    node.children.map((child) => (
                        <NameResultNode
                            key={child.relativePath}
                            depth={depth + 1}
                            handlers={handlers}
                            node={child}
                        />
                    ))
                }
            </DisclosureMotion>
        </div>
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

function ContentResultGroup({
    handlers,
    matches,
    relativePath,
}: {
    handlers: ProjectSearchResultHandlers;
    matches: FileSearchMatch[];
    relativePath: string;
}) {
    const [expanded, setExpanded] = useState(true);
    const decoration = useGitDecoration(matches[0]?.path);
    const descriptionId = useId();
    const segments = relativePath.split('/');
    const name = segments.pop() ?? relativePath;
    const directory = segments.join('/');
    return (
        <div className="search-result-group" title={relativePath}>
            <button
                type="button"
                className="sticky top-0 z-1 flex h-7 w-full min-w-0 cursor-pointer items-center gap-1.5 border-x-0 border-t-0 border-b border-border bg-surface px-2 text-left text-[11px] font-medium text-foreground hover:bg-elevated"
                aria-expanded={expanded}
                aria-describedby={decoration ? descriptionId : undefined}
                tabIndex={-1}
                onClick={() => setExpanded((value) => !value)}
            >
                {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <FileTypeIcon entry={{ kind: 'file', name }} />
                <span
                    className={cn(
                        'shrink-0',
                        decoration && gitDecorationClassName(decoration.kind),
                    )}
                >
                    {name}
                </span>
                <GitDecorationSuffix descriptionId={descriptionId} path={matches[0]?.path ?? ''} />
                {directory && (
                    <span className="min-w-0 flex-1 truncate text-muted">{directory}</span>
                )}
                <span className="ml-auto shrink-0 text-muted">{matches.length}</span>
            </button>
            <DisclosureMotion animate expanded={expanded} kind="files-content-group">
                {() =>
                    matches.map((match) => (
                        <ResultRow
                            key={searchMatchKey(match)}
                            className="min-h-7 items-start gap-2 py-1 pr-2 pl-5"
                            handlers={handlers}
                            match={match}
                            title={match.relativePath}
                        >
                            <span className="w-8 shrink-0 text-right text-muted">{match.line}</span>
                            <span className="truncate font-mono text-[11px]">
                                <HighlightedPreview match={match} />
                            </span>
                        </ResultRow>
                    ))
                }
            </DisclosureMotion>
        </div>
    );
}

export function ProjectSearchResults({
    groups,
    handlers,
    id,
    mode,
    nameTree,
}: {
    groups: ReadonlyMap<string, FileSearchMatch[]>;
    handlers: ProjectSearchResultHandlers;
    /**
     * The input's `aria-controls` points here, which is what makes it a combobox over this tree rather than a field
     * that happens to sit above a list.
     */
    id: string;
    mode: FileSearchMode;
    nameTree: readonly NameSearchNode[];
}) {
    const { t } = useTranslation();
    return (
        <div
            className="search-results min-h-0 flex-1 overflow-auto"
            id={id}
            role="tree"
            aria-label={t('projectSearch.results.label')}
        >
            {mode === 'name'
                ? nameTree.map((node) => (
                      <NameResultNode
                          key={node.relativePath}
                          depth={0}
                          handlers={handlers}
                          node={node}
                      />
                  ))
                : [...groups].map(([relativePath, matches]) => (
                      <ContentResultGroup
                          key={relativePath}
                          handlers={handlers}
                          matches={matches}
                          relativePath={relativePath}
                      />
                  ))}
        </div>
    );
}
