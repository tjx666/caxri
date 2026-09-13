import { relativeTime } from '@caxri/utils';
import { Braces, GitCommitHorizontal } from 'lucide-react';

import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useNow } from '@/hooks/use-now';

import { useCaxriQuery } from '../../queries/client';
import { sessionViewScope } from '../../stores/session-view';
import {
    editorLanguageLabel,
    editorStatusKey,
    useEditorStatusStore,
} from '../editor/editor-status';
import { StatusInfo } from './status-info';

export function ActiveFileStatus({
    sessionId,
    path,
    workbenchProjectId,
}: {
    sessionId: string;
    path: string;
    workbenchProjectId: string;
}) {
    const key = editorStatusKey(sessionViewScope(sessionId, workbenchProjectId), path);
    const editorStatus = useEditorStatusStore((state) => state.statuses[key]);
    const line = useDebouncedValue(editorStatus?.line ?? 1, 150);
    const now = useNow(30_000);
    const blameQuery = useCaxriQuery(
        'git.blame',
        { sessionId, path, line },
        { staleTime: 60_000, retry: false },
    );
    const blame = blameQuery.data;
    const language = editorLanguageLabel(editorStatus?.languageId ?? 'plaintext');
    const cursor = editorStatus
        ? `Ln ${editorStatus.line}, Col ${editorStatus.column}`
        : 'Ln 1, Col 1';
    const selection = editorStatus?.selectedCharacters ?? 0;
    return (
        <>
            {/* The existing 420px cap becomes a shrinkable slot so loading and changing blame text cannot move
                the selection and language chips beside it. */}
            {(Boolean(blame) || blameQuery.isPending) && (
                <div className="statusbar-blame-slot flex w-[420px] min-w-0 shrink items-center">
                    {blame && (
                        <StatusInfo
                            ariaLabel={
                                blame.uncommitted
                                    ? `Git blame: uncommitted changes on line ${line}`
                                    : `Git blame: ${blame.author}, ${relativeTime(blame.authoredAt, now)}, ${blame.subject}`
                            }
                            className="statusbar-blame w-full"
                            icon={GitCommitHorizontal}
                            title={
                                blame.uncommitted ? (
                                    `Uncommitted changes · line ${line}`
                                ) : (
                                    // The tooltip primitive doesn't collapse `\n` like a native `title`
                                    // attribute would, so the three-line author/sha/subject summary needs
                                    // an explicit `whitespace-pre-line` wrapper to keep its line breaks.
                                    <span className="whitespace-pre-line">
                                        {`${blame.author} · ${new Date(blame.authoredAt).toLocaleString()}\n${blame.sha}\n${blame.subject}`}
                                    </span>
                                )
                            }
                        >
                            {blame.uncommitted
                                ? 'Uncommitted changes'
                                : `${blame.author}, ${relativeTime(blame.authoredAt, now)} · ${blame.subject}`}
                        </StatusInfo>
                    )}
                </div>
            )}
            <StatusInfo
                ariaLabel={`Editor position: ${cursor}${selection > 0 ? `, ${selection} characters selected` : ''}`}
                className="statusbar-selection"
                title="Editor selection"
            >
                {selection > 0 && `${selection} selected · `}
                {cursor}
            </StatusInfo>
            <StatusInfo
                ariaLabel={`File type: ${language}`}
                className="statusbar-language"
                icon={Braces}
                title="File type"
            >
                {language}
            </StatusInfo>
        </>
    );
}
