import type { ReviewCommentText } from '@caxri/protocol';
import { reviewSideLabel } from '@caxri/protocol';

import { Button } from '../../components/ui/button';
import { Textarea } from '../../components/ui/textarea';

/**
 * `Old L4` or `New L2–5`, the Git diff review card's heading for the lines a comment cites.
 */
function rangeLabel(comment: Pick<ReviewCommentText, 'endLine' | 'side' | 'startLine'>): string {
    const end = comment.endLine > comment.startLine ? `–${comment.endLine}` : '';
    return `${reviewSideLabel(comment.side)} L${comment.startLine}${end}`;
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
    const add = (): void => {
        if (text.trim()) onAdd();
    };
    return (
        <div aria-label="Review comment" className={CARD_CLASS_NAME} role="group">
            <div className="mb-1 text-muted">
                {lineCount === 1 ? 'Comment on this line' : `Comment on ${lineCount} lines`}
                <span className="ml-2 text-[11px]">Shift-click + to extend</span>
            </div>
            <Textarea
                autoFocus
                aria-label="Comment"
                placeholder="Ask the Agent to change something…"
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
                    Cancel
                </Button>
                <Button disabled={!text.trim()} size="sm" onClick={add}>
                    Add to Chat
                </Button>
            </div>
        </div>
    );
}

/**
 * A comment already in the Chat's message, left under its lines as a record of what was asked.
 */
export function AgentChatReviewCommentNote({ comment }: { comment: ReviewCommentText }) {
    return (
        <div
            aria-label={`Comment on ${rangeLabel(comment)}`}
            className={CARD_CLASS_NAME}
            role="note"
        >
            <div className="mb-0.5 flex items-center justify-between gap-2 text-[11px] text-muted">
                <span>Review · {rangeLabel(comment)}</span>
                <span>Added to Chat</span>
            </div>
            <p className="m-0 whitespace-pre-wrap">{comment.text}</p>
        </div>
    );
}
