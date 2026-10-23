import { useMemo, useState } from 'react';

import { ListX, Send } from 'lucide-react';

import { Button } from '../../components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '../../components/ui/dialog';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { awaitThenCleanup } from '../../lib/await-then-cleanup';
import { resolveRepositoryFilePath as resolveRepoFilePath } from '../../lib/repository-file-path';
import { useCaxriQuery } from '../../queries/client';
import { getBootstrap, selectSelectedWorkbenchProject } from '../../stores/selectors';
import { clearResolvedGitReviewComments } from './git-review-comment-commands';
import { formatGitReviewComments } from './git-review-comments';
import { sendGitReviewComments } from './git-review-send-commands';

export function GitReviewSend({
    sessionId,
    repositoryId,
}: {
    sessionId: string;
    repositoryId: string;
}) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const [sending, setSending] = useState(false);
    const [sendError, setSendError] = useState<string | undefined>(undefined);
    const { data: allComments } = useCaxriQuery('gitReview.list', { sessionId, repositoryId });
    const comments = useMemo(
        () => (allComments ?? []).filter((comment) => comment.status === 'pending' && comment.text),
        [allComments],
    );
    const hasResolved = (allComments ?? []).some((comment) => comment.status !== 'pending');
    const { data: summary } = useCaxriQuery('git.summary', { sessionId });
    const repoRoot = summary?.isRepository
        ? summary.repositories.find((repo) => repo.id === repositoryId)?.rootPath
        : undefined;
    const projectRoot = selectSelectedWorkbenchProject(getBootstrap())?.rootPath;
    const prompt = formatGitReviewComments(
        comments,
        projectRoot,
        (comment) => resolveRepoFilePath(repoRoot, comment.path) ?? comment.path,
    );
    const send = async () => {
        setSending(true);
        setSendError(undefined);
        const result = await awaitThenCleanup(sendGitReviewComments(sessionId, repositoryId), () =>
            setSending(false),
        );
        if (result.ok) setOpen(false);
        else setSendError(result.message);
    };
    const sendLabel = t(
        comments.length === 1
            ? 'editor.reviewSend.sendToAgentOne'
            : 'editor.reviewSend.sendToAgentOther',
        { count: comments.length },
    );
    return (
        <>
            {hasResolved && (
                <Tooltip content={t('editor.reviewSend.clearResolved')}>
                    <Button
                        size="icon"
                        variant="ghost"
                        aria-label={t('editor.reviewSend.clearResolved')}
                        onClick={() => {
                            void clearResolvedGitReviewComments(sessionId, repositoryId);
                        }}
                    >
                        <ListX aria-hidden="true" size={14} />
                    </Button>
                </Tooltip>
            )}
            {/* A zero-count control names an action nothing can do; render it only while there is something pending. */}
            {comments.length > 0 && (
                <Tooltip content={sendLabel}>
                    <Button
                        size="icon"
                        variant="ghost"
                        aria-label={sendLabel}
                        onClick={() => {
                            setSendError(undefined);
                            setOpen(true);
                        }}
                    >
                        <Send aria-hidden="true" size={14} />
                    </Button>
                </Tooltip>
            )}
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="w-[min(720px,calc(100vw-32px))]">
                    <DialogHeader>
                        <DialogTitle>{t('editor.reviewSend.dialogTitle')}</DialogTitle>
                        <DialogDescription>
                            {t('editor.reviewSend.dialogDescription')}
                        </DialogDescription>
                    </DialogHeader>
                    <pre
                        className="max-h-[50vh] overflow-auto px-4 py-3 text-xs whitespace-pre-wrap"
                        aria-label={t('editor.reviewSend.promptPreview')}
                    >
                        {prompt}
                    </pre>
                    {sendError && (
                        <p role="alert" className="px-4 text-[11px] text-danger">
                            {sendError}
                        </p>
                    )}
                    <div className="flex justify-end gap-2 px-4 pb-4">
                        <Button variant="ghost" onClick={() => setOpen(false)}>
                            {t('common.cancel')}
                        </Button>
                        <Button disabled={sending || comments.length === 0} onClick={send}>
                            {sending
                                ? t('editor.reviewSend.sending')
                                : t(
                                      comments.length === 1
                                          ? 'editor.reviewSend.sendOne'
                                          : 'editor.reviewSend.sendOther',
                                      { count: comments.length },
                                  )}
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
        </>
    );
}
