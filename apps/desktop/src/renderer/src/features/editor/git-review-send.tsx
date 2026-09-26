import { useMemo, useState } from 'react';

import { Button } from '../../components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '../../components/ui/dialog';
import { resolveRepositoryFilePath as resolveRepoFilePath } from '../../lib/repository-file-path';
import { useCaxriQuery } from '../../queries/client';
import { getBootstrap, selectSelectedWorkbenchProject } from '../../stores/selectors';
import { formatGitReviewComments, useGitReviewComments } from './git-review-comments';
import { didSendGitReviewComments } from './git-review-send-commands';

export function GitReviewSend({
    sessionId,
    repositoryId,
}: {
    sessionId: string;
    repositoryId: string;
}) {
    const [open, setOpen] = useState(false);
    const [sending, setSending] = useState(false);
    const allComments = useGitReviewComments((state) => state.comments);
    const comments = useMemo(
        () =>
            allComments.filter(
                (comment) =>
                    comment.sessionId === sessionId &&
                    comment.repositoryId === repositoryId &&
                    comment.status === 'pending' &&
                    comment.text,
            ),
        [allComments, sessionId, repositoryId],
    );
    const hasResolved = allComments.some(
        (comment) =>
            comment.sessionId === sessionId &&
            comment.repositoryId === repositoryId &&
            comment.status !== 'pending',
    );
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
        try {
            if (await didSendGitReviewComments(sessionId, comments, prompt)) setOpen(false);
        } finally {
            setSending(false);
        }
    };
    return (
        <>
            <div className="git-review-send absolute top-1 right-2 z-20 flex items-center gap-1">
                {hasResolved && (
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                            useGitReviewComments.getState().clearResolved(sessionId, repositoryId)
                        }
                    >
                        Clear sent and outdated
                    </Button>
                )}
                <Button
                    size="sm"
                    variant="secondary"
                    disabled={comments.length === 0}
                    onClick={() => setOpen(true)}
                >
                    Send {comments.length} {comments.length === 1 ? 'comment' : 'comments'} to Agent
                </Button>
            </div>
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
