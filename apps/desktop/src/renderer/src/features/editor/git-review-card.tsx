import { useState } from 'react';

import type { GitReviewComment } from './git-review-comments';
import { useGitReviewComments } from './git-review-comments';

export function GitReviewCard({ comment }: { comment: GitReviewComment }) {
    const [editing, setEditing] = useState(!comment.text);
    const [draft, setDraft] = useState(comment.text);
    const edit = (id: string, text: string) => useGitReviewComments.getState().edit(id, text);
    const remove = (id: string) => useGitReviewComments.getState().remove(id);
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
                    Review · {comment.side} L{comment.startLine}
                    {comment.endLine > comment.startLine ? `–${comment.endLine}` : ''}
                </span>
                <span className={`git-review-status git-review-status-${comment.status}`}>
                    {comment.status}
                </span>
            </div>
            {editing ? (
                <textarea
                    autoFocus
                    aria-label="Review comment"
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
                {editing ? (
                    <button type="button" onClick={save}>
                        Save
                    </button>
                ) : (
                    <button
                        type="button"
                        onClick={() => {
                            setDraft(comment.text);
                            setEditing(true);
                        }}
                    >
                        Edit
                    </button>
                )}
                <button type="button" onClick={() => remove(comment.id)}>
                    Delete
                </button>
            </div>
        </div>
    );
}
