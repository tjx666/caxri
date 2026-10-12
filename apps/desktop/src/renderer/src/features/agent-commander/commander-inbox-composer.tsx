import { useRef } from 'react';

import type { CommanderInboxItem } from '@caxri/protocol';
import { CornerDownLeft, X } from 'lucide-react';

import { SuggestionList } from '../../components/suggestion-list';
import { Button } from '../../components/ui/button';
import { Textarea } from '../../components/ui/textarea';
import { Tooltip } from '../../components/ui/tooltip';
import { inboxMentionSuggestion } from './commander-inbox';
import { useCommanderInboxComposer } from './hooks/use-commander-inbox-composer';

/**
 * The reply box under the Inbox list. It answers one item at a time: the chosen one, or the only open question.
 */
export function CommanderInboxComposer({ items }: { items: readonly CommanderInboxItem[] }) {
    const textareaReference = useRef<HTMLTextAreaElement>(null);
    const composer = useCommanderInboxComposer(items, textareaReference);
    const { target } = composer;
    return (
        <div className="commander-inbox-composer relative flex flex-none flex-col gap-1.5 border-t border-border p-2">
            {composer.candidates.length > 0 && (
                <SuggestionList
                    activeIndex={composer.activeIndex}
                    className="inset-x-2"
                    footer="↑↓ to move · Enter to choose"
                    label="Inbox items"
                    listId={composer.listId}
                    suggestions={composer.candidates.map(inboxMentionSuggestion)}
                    onChoose={composer.chooseAt}
                    onHover={composer.highlight}
                />
            )}
            <div className="flex h-5 min-w-0 items-center gap-1 text-[11px] text-muted">
                {target ? (
                    <>
                        <span className="flex-none">Replying to</span>
                        <span className="commander-inbox-target min-w-0 truncate text-foreground">
                            {target.title}
                        </span>
                        <Tooltip content="Clear the reply target">
                            <button
                                type="button"
                                aria-label="Clear the reply target"
                                className="flex size-4 flex-none cursor-pointer items-center justify-center rounded hover:text-foreground"
                                onClick={composer.clearTarget}
                            >
                                <X size={12} />
                            </button>
                        </Tooltip>
                    </>
                ) : (
                    <span>Type @ to choose the item you are answering.</span>
                )}
            </div>
            <div className="flex items-end gap-1.5">
                <Textarea
                    ref={textareaReference}
                    aria-label="Reply to the Commander"
                    {...composer.inputAria}
                    role="combobox"
                    rows={2}
                    className="commander-inbox-input min-h-0 resize-none text-[12px]"
                    placeholder={target ? 'Your answer' : '@ an item, then your answer'}
                    value={composer.draft}
                    onChange={composer.onChange}
                    onKeyDown={composer.onKeyDown}
                    onSelect={composer.onSelect}
                />
                <Tooltip content="Send (Enter)">
                    <Button
                        aria-label="Send reply"
                        size="sm"
                        variant="secondary"
                        className="commander-inbox-send flex-none"
                        disabled={!target || composer.draft.trim() === '' || composer.isSending}
                        onClick={() => {
                            // Fire-and-forget: the reply command reports its own failure through a toast.
                            // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
                            void composer.send();
                        }}
                    >
                        <CornerDownLeft size={13} />
                    </Button>
                </Tooltip>
            </div>
        </div>
    );
}
