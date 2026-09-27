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
        try {
            const result = await sendGitReviewComments(sessionId, repositoryId);
            if (result.ok) setOpen(false);
            else setSendError(result.message);
        } finally {
            setSending(false);
        }
    };
    const sendLabel = `Send ${comments.length} ${comments.length === 1 ? 'comment' : 'comments'} to Agent`;
    return (
        <>
            {hasResolved && (
                <Tooltip content="Clear sent and outdated">
                    <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Clear sent and outdated"
                        onClick={() => {
                            // eslint-disable-next-line no-void -- floating-promise discard: list refetches via `gitReview.changed`
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
                        <DialogTitle>Send review comments to Agent</DialogTitle>
                        <DialogDescription>
                            Review the text before sending it to the current Session's Agent
                            Terminal.
                        </DialogDescription>
                    </DialogHeader>
                    <pre
                        className="max-h-[50vh] overflow-auto px-4 py-3 text-xs whitespace-pre-wrap"
                        aria-label="Review comment prompt preview"
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
                            Cancel
                        </Button>
                        <Button disabled={sending || comments.length === 0} onClick={send}>
                            {sending
                                ? 'Sending…'
                                : `Send ${comments.length} ${comments.length === 1 ? 'comment' : 'comments'}`}
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
        </>
    );
}
