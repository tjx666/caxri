import { useRef } from 'react';

import type { CommanderInboxItem } from '@caxri/protocol';
import { CornerDownLeft, X } from 'lucide-react';

import { SuggestionList } from '../../components/suggestion-list';
import { Button } from '../../components/ui/button';
import { Textarea } from '../../components/ui/textarea';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { inboxMentionSuggestion, inboxSendTooltip } from './commander-inbox';
import { useCommanderInboxComposer } from './hooks/use-commander-inbox-composer';

/**
 * The reply box under the Inbox list. It answers one item at a time: the chosen one, or the only open question.
 */
export function CommanderInboxComposer({ items }: { items: readonly CommanderInboxItem[] }) {
    const { t } = useTranslation();
    const textareaReference = useRef<HTMLTextAreaElement>(null);
    const composer = useCommanderInboxComposer(items, textareaReference);
    const { target } = composer;
    return (
        <div className="commander-inbox-composer relative flex flex-none flex-col gap-1.5 border-t border-border p-2">
            {composer.candidates.length > 0 && (
                <SuggestionList
                    activeIndex={composer.activeIndex}
                    className="inset-x-2"
                    footer={[
                        { keys: '↑↓', action: t('common.keyHint.move') },
                        { keys: 'Enter', action: t('common.keyHint.choose') },
                    ]}
                    label={t('agentCommander.composer.suggestionLabel')}
                    listId={composer.listId}
                    suggestions={composer.candidates.map((item) => inboxMentionSuggestion(item, t))}
                    onChoose={composer.chooseAt}
                    onHover={composer.highlight}
                />
            )}
            <div className="flex h-5 min-w-0 items-center gap-1 text-[11px] text-muted">
                {target ? (
                    <>
                        <span className="flex-none">{t('agentCommander.composer.replyingTo')}</span>
                        <span className="commander-inbox-target min-w-0 truncate text-foreground">
                            {target.title}
                        </span>
                        <Tooltip content={t('agentCommander.composer.clearTarget')}>
                            <button
                                type="button"
                                aria-label={t('agentCommander.composer.clearTarget')}
                                className="flex size-4 flex-none cursor-pointer items-center justify-center rounded-md hover:text-foreground"
                                onClick={composer.clearTarget}
                            >
                                <X size={12} />
                            </button>
                        </Tooltip>
                    </>
                ) : (
                    <span
                        className={cn(
                            'commander-inbox-hint transition-colors',
                            composer.isHintFlashing && 'text-foreground',
                        )}
                        data-flashing={composer.isHintFlashing || undefined}
                    >
                        {t('agentCommander.composer.mentionHint')}
                    </span>
                )}
            </div>
            <div className="flex items-end gap-1.5">
                <Textarea
                    ref={textareaReference}
                    aria-label={t('agentCommander.composer.inputLabel')}
                    {...composer.inputAria}
                    role="combobox"
                    rows={2}
                    className="commander-inbox-input min-h-0 resize-none text-[12px]"
                    placeholder={t(
                        target
                            ? 'agentCommander.composer.placeholderWithTarget'
                            : 'agentCommander.composer.placeholder',
                    )}
                    value={composer.draft}
                    onChange={composer.onChange}
                    onKeyDown={composer.onKeyDown}
                    onSelect={composer.onSelect}
                />
                <Tooltip
                    content={inboxSendTooltip(
                        { draft: composer.draft, hasTarget: target !== undefined },
                        t,
                    )}
                >
                    <Button
                        aria-label={t('agentCommander.composer.sendLabel')}
                        size="sm"
                        variant="secondary"
                        className="commander-inbox-send flex-none"
                        // `aria-disabled` rather than `disabled`: Chromium sends no hover to a disabled button, so its
                        // Tooltip could never say why Send is unavailable. `send()` refuses the same states itself.
                        aria-disabled={
                            !target ||
                            composer.draft.trim() === '' ||
                            composer.isSending ||
                            undefined
                        }
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
