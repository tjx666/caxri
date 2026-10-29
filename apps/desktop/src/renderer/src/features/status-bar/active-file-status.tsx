import { Braces, GitCommitHorizontal } from 'lucide-react';

import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useRelativeTime } from '@/hooks/use-relative-time';

import { useTranslation } from '../../i18n';
import { formatDateTime } from '../../lib/locale-format';
import { useCaxriQuery } from '../../queries/client';
import { sessionViewScope } from '../../stores/session-view';
import {
    editorLanguageLabel,
    editorStatusKey,
    useEditorStatusStore,
} from '../editor/editor-status';
import type { ActiveFileStatusTier } from './active-file-status-target';
import { StatusInfo } from './status-info';

export function ActiveFileStatus({
    sessionId,
    path,
    tier,
    workbenchRootProjectId,
}: {
    sessionId: string;
    path: string;
    tier: Exclude<ActiveFileStatusTier, 'hidden'>;
    workbenchRootProjectId: string;
}) {
    const { t } = useTranslation();
    const key = editorStatusKey(sessionViewScope(sessionId, workbenchRootProjectId), path);
    const editorStatus = useEditorStatusStore((state) => state.statuses[key]);
    // An external document shows only what its own editor published. A tab whose editor never reported (its file is
    // gone or unreadable) shows nothing rather than a made-up `Ln 1, Col 1` in Plain Text.
    if (tier === 'cursorOnly' && !editorStatus) return null;
    const language = editorLanguageLabel(editorStatus?.languageId ?? 'plaintext', t);
    const cursor = t('statusBar.file.cursor', {
        line: editorStatus?.line ?? 1,
        column: editorStatus?.column ?? 1,
    });
    const selection = editorStatus?.selectedCharacters ?? 0;
    return (
        <>
            {tier === 'full' && (
                <ActiveFileBlame
                    cursorLine={editorStatus?.line ?? 1}
                    path={path}
                    sessionId={sessionId}
                />
            )}
            <StatusInfo
                ariaLabel={
                    selection > 0
                        ? t('statusBar.file.positionWithSelectionAriaLabel', {
                              cursor,
                              count: selection,
                          })
                        : t('statusBar.file.positionAriaLabel', { cursor })
                }
                className="statusbar-selection"
                title={t('statusBar.file.selectionTitle')}
            >
                {selection > 0 && t('statusBar.file.selected', { count: selection })}
                {cursor}
            </StatusInfo>
            <StatusInfo
                ariaLabel={t('statusBar.file.typeAriaLabel', { language })}
                className="statusbar-language"
                icon={<Braces />}
                title={t('statusBar.file.type')}
            >
                {language}
            </StatusInfo>
        </>
    );
}

/**
 * Current-line blame. A component of its own so that a tab without blame never mounts the query at all, and so the
 * debounced line re-renders only this slot rather than the cursor and language chips beside it.
 */
function ActiveFileBlame({
    cursorLine,
    path,
    sessionId,
}: {
    cursorLine: number;
    path: string;
    sessionId: string;
}) {
    const { t } = useTranslation();
    const line = useDebouncedValue(cursorLine, 150);
    const blameQuery = useCaxriQuery(
        'git.blame',
        { sessionId, path, line },
        { staleTime: 60_000, retry: false },
    );
    const blame = blameQuery.data;
    const authored = useRelativeTime(blame?.authoredAt);
    /*
     * The existing 420px cap becomes a shrinkable slot so loading and changing blame text cannot move the selection and
     * language chips beside it.
     *
     * While the query is pending the slot renders empty, and that costs nothing: `w-full` resolves against
     * `.statusbar-actions`, which is itself content-sized, so an empty slot measures 0px rather than reserving 420.
     * Measured over CDP at the 960px minimum window width; Workbench Root and branch keep 740px either way, and the only
     * pending-to-settled shift is the language chip's own text. Do not "fix" this by giving the slot a fixed width. See
     * issue #894.
     */
    if (!blame && !blameQuery.isPending) return null;
    return (
        <div className="statusbar-blame-slot flex w-full max-w-[420px] min-w-0 shrink items-center">
            {blame && (
                <StatusInfo
                    ariaLabel={
                        blame.uncommitted
                            ? t('statusBar.file.blameUncommittedAriaLabel', { line })
                            : t('statusBar.file.blameAriaLabel', {
                                  author: blame.author,
                                  time: authored ?? '',
                                  subject: blame.subject,
                              })
                    }
                    className="statusbar-blame w-full"
                    icon={<GitCommitHorizontal />}
                    title={
                        blame.uncommitted ? (
                            t('statusBar.file.blameUncommittedTitle', { line })
                        ) : (
                            // The tooltip primitive doesn't collapse `\n` like a native `title`
                            // attribute would, so the three-line author/sha/subject summary needs
                            // an explicit `whitespace-pre-line` wrapper to keep its line breaks.
                            <span className="whitespace-pre-line">
                                {`${blame.author} · ${formatDateTime(blame.authoredAt, t.locale)}\n${blame.sha}\n${blame.subject}`}
                            </span>
                        )
                    }
                >
                    {blame.uncommitted
                        ? t('statusBar.file.uncommittedChanges')
                        : `${blame.author}, ${authored} · ${blame.subject}`}
                </StatusInfo>
            )}
        </div>
    );
}
