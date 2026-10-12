import { useMemo } from 'react';

import type { AgentTurnReviewTab } from '@caxri/protocol';
import {
    agentChatChangeDecoration,
    agentChatEditedFilesStat,
    projectDisplayPath,
} from '@caxri/protocol';
import { ArrowLeft } from 'lucide-react';

import { DiffStat } from '../../components/diff-stat';
import { GitFileStatusLetter } from '../../components/git-file-status-letter';
import { LoadingSkeleton } from '../../components/loading-skeleton';
import { Button } from '../../components/ui/button';
import { useTranslation } from '../../i18n';
import { useCaxriQuery } from '../../queries/client';
import { usePaneViewSession } from '../workbench/pane-view-session';
import { agentChatLocalizedChangeKindLabel } from './agent-chat-diff-labels';
import { AgentChatDiff } from './agent-chat-file-changes';
import {
    AgentChatReviewCommentCard,
    AgentChatReviewCommentNote,
} from './agent-chat-review-comment-card';
import { revealAgentChat } from './agent-chat-task-opener';
import { collectAgentChatTurnReview } from './agent-chat-turn-review';
import { useAgentChatReviewComments } from './hooks/use-agent-chat-review-comments';

const STATE_CLASS_NAME =
    'flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-[13px] text-muted';

/**
 * One turn's file changes as a single review: every file the turn changed, each merged across the turn's edits to it,
 * as the Codex app and t3code review a turn. A comment on a line range is added to the Chat's message (see
 * `useAgentChatReviewComments`), so the next message can ask the Agent to follow up on it.
 */
export function AgentChatTurnReviewTab({ tab }: { tab: AgentTurnReviewTab }) {
    const { terminalId, turnId } = tab;
    const chat = useCaxriQuery('agentChat.read', { terminalId }, { staleTime: Infinity });
    const projectRoot = usePaneViewSession()?.rootPath;
    const items = chat.data?.items;
    const files = useMemo(
        () => (items ? collectAgentChatTurnReview(items, turnId) : []),
        [items, turnId],
    );
    const comments = useAgentChatReviewComments({ files, projectRoot, terminalId });
    const { t } = useTranslation();
    if (chat.isPending)
        return <LoadingSkeleton variant="document" label={t('agentChat.review.loading')} />;
    if (chat.isError)
        return <div className={STATE_CLASS_NAME}>{t('agentChat.review.unavailable')}</div>;
    if (files.length === 0)
        return (
            <div className={STATE_CLASS_NAME}>
                {t('agentChat.review.noChanges')}
                <Button size="sm" variant="secondary" onClick={() => revealAgentChat(terminalId)}>
                    {t('agentChat.review.backToChat')}
                </Button>
            </div>
        );
    const displayPath = (path: string): string => projectDisplayPath(path, projectRoot);
    const stat = agentChatEditedFilesStat(files.map(({ file }) => file));
    return (
        <div className="flex h-full min-h-0 flex-col bg-background" data-agent-chat-turn-review="">
            <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2">
                <div className="min-w-0 flex-1">
                    <h2 className="m-0 text-[13px] leading-5 font-semibold text-foreground">
                        {t('agentChat.review.title')}
                    </h2>
                    <p className="m-0 flex items-center gap-2 text-[11px] leading-4 text-muted">
                        {files.length === 1
                            ? t('agentChat.review.fileCountOne')
                            : t('agentChat.review.fileCountOther', { count: files.length })}
                        <DiffStat additions={stat.additions} deletions={stat.deletions} />
                    </p>
                </div>
                <Button
                    className="shrink-0 gap-1 text-[12px]"
                    size="sm"
                    variant="ghost"
                    onClick={() => revealAgentChat(terminalId)}
                >
                    <ArrowLeft aria-hidden="true" className="size-3.5" />
                    {t('agentChat.review.backToChat')}
                </Button>
            </header>
            <div className="min-h-0 flex-1 overflow-auto">
                {files.map(({ file, lines }) => {
                    const path = displayPath(file.path);
                    const draft = comments.draft?.path === file.path ? comments.draft : undefined;
                    const added = comments.added.filter((entry) => entry.path === file.path);
                    return (
                        <section
                            aria-label={path}
                            className="border-b border-border"
                            key={file.path}
                        >
                            <div className="sticky top-0 z-10 flex h-8 min-w-0 items-center gap-2 border-b border-border bg-surface px-3 text-[12px]">
                                <GitFileStatusLetter
                                    className="text-[11px]"
                                    decoration={agentChatChangeDecoration(file.kind)}
                                />
                                <span className="sr-only">
                                    {agentChatLocalizedChangeKindLabel(file.kind, t)}
                                </span>
                                <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                                    {path}
                                </span>
                                <DiffStat additions={file.additions} deletions={file.deletions} />
                            </div>
                            <AgentChatDiff
                                isBounded={false}
                                lines={lines}
                                review={{
                                    selected: draft?.range,
                                    onComment: (index, isExtending) =>
                                        comments.begin(file.path, index, isExtending),
                                    renderAfter: (index) => (
                                        <>
                                            {added
                                                .filter((entry) => entry.range.end === index)
                                                .map((entry) => (
                                                    <AgentChatReviewCommentNote
                                                        comment={entry.comment}
                                                        key={entry.id}
                                                    />
                                                ))}
                                            {draft?.range.end === index && (
                                                <AgentChatReviewCommentCard
                                                    lineCount={
                                                        draft.range.end - draft.range.start + 1
                                                    }
                                                    text={draft.text}
                                                    onAdd={comments.addToChat}
                                                    onCancel={comments.cancel}
                                                    onChange={comments.write}
                                                />
                                            )}
                                        </>
                                    ),
                                }}
                                truncated={file.truncated}
                            />
                        </section>
                    );
                })}
            </div>
        </div>
    );
}
