import type { FileSearchMatch } from '@caxri/protocol';

import { Spinner } from '../../components/ui/spinner';
import { FileTypeIcon } from '../../icons/files/file-type-icon';
import { cn } from '../../lib/utilities';
import { useCaxriQuery } from '../../queries/client';
import { searchSnippetLines } from './project-search-snippet';

function PreviewMessage({ children }: { children: React.ReactNode }) {
    return <div className="grid min-h-0 flex-1 place-items-center p-4 text-muted">{children}</div>;
}

/**
 * The snippet pane beside the results.
 *
 * It reads the file through `files.read` rather than asking the search for more context, because a search result
 * carries only the matching line and widening that would make every scan pay for context the user reads one file at a
 * time. Only the selected file is fetched, and React Query keeps it while the user steps back and forth through the
 * same few results.
 */
export function ProjectSearchPreview({
    match,
    sessionId,
}: {
    match: FileSearchMatch | undefined;
    sessionId: string;
}) {
    const document = useCaxriQuery(
        'files.read',
        { sessionId, path: match?.path ?? '' },
        { enabled: match !== undefined },
    );
    if (!match) return <PreviewMessage>Select a result to preview it.</PreviewMessage>;
    if (document.isPending)
        return (
            <PreviewMessage>
                <Spinner size={16} />
            </PreviewMessage>
        );
    if (document.isError) return <PreviewMessage>Unable to read this file.</PreviewMessage>;
    const name = match.relativePath.split('/').at(-1) ?? match.relativePath;
    return (
        <div className="search-preview flex min-h-0 flex-1 flex-col">
            <div className="flex h-8 flex-none items-center gap-1.5 border-b border-border px-3 text-[11px]">
                <FileTypeIcon entry={{ kind: 'file', name }} />
                <span className="truncate text-foreground">{name}</span>
                <span className="min-w-0 flex-1 truncate text-muted">{match.relativePath}</span>
            </div>
            <div className="min-h-0 flex-1 overflow-auto py-2 font-mono text-[11px] leading-5">
                {searchSnippetLines(document.data.content, match.line).map((line) => (
                    <div
                        key={line.number}
                        className={cn(
                            'flex gap-3 px-3',
                            line.isMatch &&
                                'bg-[color-mix(in_srgb,var(--warning)_18%,transparent)]',
                        )}
                        data-search-preview-line={line.number}
                        data-search-preview-match={line.isMatch ? '' : undefined}
                    >
                        <span className="w-10 flex-none text-right text-muted tabular-nums">
                            {line.number}
                        </span>
                        <span className="min-w-0 wrap-anywhere whitespace-pre-wrap text-foreground">
                            {line.text}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}
