import { useState } from 'react';

import { Button } from '../../components/ui/button';
import { Textarea } from '../../components/ui/textarea';
import { editGitReviewComment, removeGitReviewComment } from './git-review-comment-commands';
import type { GitReviewComment } from './git-review-comments';
import { reviewSideLabel } from './git-review-comments';

export function GitReviewCard({ comment }: { comment: GitReviewComment }) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState('');
    const isEditing = editing || !comment.text;
    // eslint-disable-next-line no-void -- floating-promise discard: comment refetches via `gitReview.changed`
    const edit = (id: string, text: string) => void editGitReviewComment(id, text);
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    const remove = (id: string) => void removeGitReviewComment(id);
    const save = () => {
        if (!draft.trim()) return;
        edit(comment.id, draft.trim());
        setEditing(false);
    };
    return (
        <div
            className="git-review-card"
            role="group"
            aria-label={`Review comment for lines ${comment.startLine} to ${comment.endLine}`}
        >
            <div className="git-review-card-heading">
                <span>
                    Review · {reviewSideLabel(comment.side)} L{comment.startLine}
                    {comment.endLine > comment.startLine ? `–${comment.endLine}` : ''}
                </span>
                <span className={`git-review-status git-review-status-${comment.status}`}>
                    {comment.status}
                </span>
            </div>
            {isEditing ? (
                <Textarea
                    autoFocus
                    aria-label="Review comment"
                    className="my-1"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter' && event.metaKey) {
                            event.preventDefault();
                            save();
                        }
                        if (event.key === 'Escape') {
                            event.preventDefault();
                            if (!comment.text) remove(comment.id);
                            else setEditing(false);
                        }
                    }}
                />
            ) : (
                <p>{comment.text}</p>
            )}
            <div className="git-review-card-actions">
                {isEditing ? (
                    <Button size="sm" variant="ghost" onClick={save}>
                        Save
                    </Button>
                ) : (
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                            setDraft(comment.text);
                            setEditing(true);
                        }}
                    >
                        Edit
                    </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => remove(comment.id)}>
                    Delete
                </Button>
            </div>
        </div>
    );
}
