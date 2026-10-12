import { useMemo } from 'react';

import type { FileSearchMatch } from '@caxri/protocol';

import { useDebouncedValue } from '@/hooks/use-debounced-value';

import { LoadingSkeleton } from '../../components/loading-skeleton';
import { useTranslation } from '../../i18n';
import { FileTypeIcon } from '../../icons/files/file-type-icon';
import { cn } from '../../lib/utilities';
import { useCaxriQuery } from '../../queries/client';
import type { SearchSnippetLine } from './project-search-snippet';
import { searchSnippetLines } from './project-search-snippet';

/**
 * Matches the query field's debounce. Holding an arrow key sweeps the selection across results faster than a person can
 * read one, and each distinct file costs a whole-file `files.read`; this makes a sweep pay for where it stops.
 */
const PREVIEW_SETTLE_MS = 150;

/**
 * A previewed file is read in full and only nine of its lines are ever shown, so the body is worth far less in the
 * cache than it costs to hold. Short enough that stepping back over a handful of results still hits, short enough that
 * walking a 500-result list does not pin 500 file bodies for the client default of five minutes.
 */
const PREVIEW_CACHE_MS = 30_000;

const NO_LINES: SearchSnippetLine[] = [];

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
    // Everything below renders from `previewed`, so a sweep keeps showing the last settled file instead of flashing a
    // spinner per row it passes over.
    const { t } = useTranslation();
    const previewed = useDebouncedValue(match, PREVIEW_SETTLE_MS);
    const document = useCaxriQuery(
        'files.read',
        { sessionId, path: previewed?.path ?? '' },
        { enabled: previewed !== undefined, gcTime: PREVIEW_CACHE_MS },
    );
    // Splitting a file that may be `files.maxFileBytes` large is not a render-body cost: the dialog re-renders on every
    // keystroke, and only nine of those lines survive the call.
    const lines = useMemo(
        () =>
            document.data ? searchSnippetLines(document.data.content, previewed?.line) : NO_LINES,
        [document.data, previewed?.line],
    );
    if (!match) return <PreviewMessage>{t('projectSearch.preview.empty')}</PreviewMessage>;
    if (!previewed || document.isPending)
        return (
            <LoadingSkeleton
                variant="document"
                className="min-h-0 flex-1"
                label={t('projectSearch.preview.loading')}
                lines={9}
            />
        );
    if (document.isError)
        return <PreviewMessage>{t('projectSearch.preview.readFailed')}</PreviewMessage>;
    const name = previewed.relativePath.split('/').at(-1) ?? previewed.relativePath;
    return (
        <div className="search-preview flex min-h-0 flex-1 flex-col">
            <div className="flex h-8 flex-none items-center gap-1.5 border-b border-border px-3 text-[11px]">
                <FileTypeIcon entry={{ kind: 'file', name }} />
                <span className="truncate text-foreground">{name}</span>
                <span className="min-w-0 flex-1 truncate text-muted">{previewed.relativePath}</span>
            </div>
            <div className="min-h-0 flex-1 overflow-auto py-2 font-mono text-[11px] leading-5">
                {lines.map((line) => (
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
