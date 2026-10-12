import { useState } from 'react';

import { Button } from '../../components/ui/button';
import { Textarea } from '../../components/ui/textarea';
import type { Translate } from '../../i18n';
import { translate, useLocaleStore } from '../../i18n';
import { editGitReviewComment, removeGitReviewComment } from './git-review-comment-commands';
import type { GitReviewComment } from './git-review-comments';

/**
 * The card mounts in its own React root inside a Monaco view zone (`git-review-comment-binding.ts`), outside the
 * window's `I18nProvider`, so `useTranslation()` would not see the active locale. Subscribing to the module-level
 * locale store re-renders the card on a language change and keeps `translate()` current.
 */
function useViewZoneTranslate(): Translate {
    useLocaleStore((state) => state.locale);
    return translate;
}

export function GitReviewCard({ comment }: { comment: GitReviewComment }) {
    const t = useViewZoneTranslate();
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
            aria-label={t('editor.review.cardLabel', {
                start: comment.startLine,
                end: comment.endLine,
            })}
        >
            <div className="git-review-card-heading">
                <span>
                    {t('editor.review.heading', {
                        side: t(`editor.review.side.${comment.side}`),
                        lines:
                            comment.endLine > comment.startLine
                                ? `${comment.startLine}–${comment.endLine}`
                                : comment.startLine,
                    })}
                </span>
                <span className={`git-review-status git-review-status-${comment.status}`}>
                    {t(`editor.review.status.${comment.status}`)}
                </span>
            </div>
            {isEditing ? (
                <Textarea
                    autoFocus
                    aria-label={t('editor.review.commentInput')}
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
                        {t('common.save')}
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
                        {t('common.edit')}
                    </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => remove(comment.id)}>
                    {t('common.delete')}
                </Button>
            </div>
        </div>
    );
}
