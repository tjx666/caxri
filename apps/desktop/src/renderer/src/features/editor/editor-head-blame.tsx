import { relativeTime } from '@caxri/utils';
import { GitCommitHorizontal } from 'lucide-react';

import { useNow } from '@/hooks/use-now';

import { useCaxriQuery } from '../../queries/client';

/**
 * GitLens-style file annotation above the editor: who last changed this file, when, and the commit subject. Renders
 * nothing while the file has no committed history (untracked, outside a repository, or still loading).
 */
export function EditorHeadBlame({ path, sessionId }: { path: string; sessionId: string }) {
    const now = useNow(30_000);
    const head = useCaxriQuery(
        'git.fileHead',
        { sessionId, path },
        { staleTime: 60_000, retry: false },
    ).data;
    if (!head) return null;
    const absoluteTime = new Date(head.authoredAt).toLocaleString();
    return (
        <div
            className="editor-head-blame ml-auto flex max-w-96 min-w-0 shrink items-center gap-1.5 overflow-hidden px-3 text-[11px] text-muted"
            // The full annotation stays reachable when the inline text truncates: `title` for
            // pointer users, `aria-label` for assistive technology.
            aria-label={`Last change: ${head.author}, ${absoluteTime}, ${head.subject}`}
            title={`${head.author} · ${absoluteTime}\n${head.sha}\n${head.subject}`}
        >
            <GitCommitHorizontal className="shrink-0" size={12} />
            <span className="truncate">
                {head.author}, {relativeTime(head.authoredAt, now)} · {head.subject}
            </span>
        </div>
    );
}
