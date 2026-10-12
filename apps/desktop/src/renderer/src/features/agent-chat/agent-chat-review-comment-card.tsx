import type { ReviewCommentText } from '@caxri/protocol';

import { Button } from '../../components/ui/button';
import { Textarea } from '../../components/ui/textarea';
import type { Translate } from '../../i18n';
import { useTranslation } from '../../i18n';

/**
 * `Old L4` or `New L2–5`, the Git diff review card's heading for the lines a comment cites. The side word is translated
 * here rather than through `reviewSideLabel`, whose English text is also part of the comment sent to the Agent.
 */
function rangeLabel(
    comment: Pick<ReviewCommentText, 'endLine' | 'side' | 'startLine'>,
    t: Translate,
): string {
    const end = comment.endLine > comment.startLine ? `–${comment.endLine}` : '';
    return `${t(`agentChat.review.side.${comment.side}`)} L${comment.startLine}${end}`;
}

const CARD_CLASS_NAME =
    'sticky left-0 my-1 ml-5 w-[min(36rem,calc(100%-2rem))] rounded-md border border-border bg-elevated px-2.5 py-2 font-sans text-[12px] text-foreground';

/**
 * Writing a comment on a turn's diff, with the Git diff review card's keys: Cmd+Enter adds it to the Chat's message and
 * Escape cancels. Nothing is sent; the comment waits in the composer with the rest of the message.
 */
export function AgentChatReviewCommentCard({
    lineCount,
    text,
    onAdd,
    onCancel,
    onChange,
}: {
    lineCount: number;
    text: string;
    onAdd: () => void;
    onCancel: () => void;
    onChange: (text: string) => void;
}) {
    const { t } = useTranslation();
    const add = (): void => {
        if (text.trim()) onAdd();
    };
    return (
        <div
            aria-label={t('agentChat.review.commentGroup')}
            className={CARD_CLASS_NAME}
            role="group"
        >
            <div className="mb-1 text-muted">
                {lineCount === 1
                    ? t('agentChat.review.commentOnThisLine')
                    : t('agentChat.review.commentOnLines', { count: lineCount })}
                <span className="ml-2 text-[11px]">{t('agentChat.review.extendHint')}</span>
            </div>
            <Textarea
                autoFocus
                aria-label={t('agentChat.review.commentLabel')}
                placeholder={t('agentChat.review.commentPlaceholder')}
                value={text}
                onChange={(event) => onChange(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === 'Enter' && event.metaKey) {
                        event.preventDefault();
                        add();
                    }
                    if (event.key === 'Escape') {
                        event.preventDefault();
                        onCancel();
                    }
                }}
            />
            <div className="mt-1.5 flex justify-end gap-1.5">
                <Button size="sm" variant="ghost" onClick={onCancel}>
                    {t('common.cancel')}
                </Button>
                <Button disabled={!text.trim()} size="sm" onClick={add}>
                    {t('agentChat.review.addToChat')}
                </Button>
            </div>
        </div>
    );
}

/**
 * A comment already in the Chat's message, left under its lines as a record of what was asked.
 */
export function AgentChatReviewCommentNote({ comment }: { comment: ReviewCommentText }) {
    const { t } = useTranslation();
    const range = rangeLabel(comment, t);
    return (
        <div
            aria-label={t('agentChat.review.commentOnRange', { range })}
            className={CARD_CLASS_NAME}
            role="note"
        >
            <div className="mb-0.5 flex items-center justify-between gap-2 text-[11px] text-muted">
                <span>{t('agentChat.review.noteHeading', { range })}</span>
                <span>{t('agentChat.review.addedToChat')}</span>
            </div>
            <p className="m-0 whitespace-pre-wrap">{comment.text}</p>
        </div>
    );
}
