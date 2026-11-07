import { useRef, useState } from 'react';

import { useTranslation } from '../../../../i18n';
import { cn } from '../../../../lib/utilities';
import { useIsAgentChatClamped } from '../../hooks/use-is-agent-chat-clamped';
import { AgentChatMessage } from '../../messages/agent-chat-message';

/**
 * The question an Agent asks, rendered as Markdown like its replies so paragraphs, numbered steps, and `code` keep
 * their shape instead of running together in one bold block. A long question folds to about seven lines behind a fade
 * with Show more, so the options below it stay in view; the form keys it by question, so each one starts folded. The
 * answered record reuses it in its quieter type, so a question reads the same before and after it is answered.
 */
export function AgentChatQuestionBody({ className, text }: { className?: string; text: string }) {
    const { t } = useTranslation();
    const [isExpanded, setExpanded] = useState(false);
    const bodyReference = useRef<HTMLDivElement>(null);
    const isCut = useIsAgentChatClamped(bodyReference, { content: text, isClamped: !isExpanded });
    return (
        <div>
            <div
                ref={bodyReference}
                className={cn(
                    'select-text',
                    !isExpanded && 'max-h-35 overflow-hidden',
                    !isExpanded &&
                        isCut &&
                        '[mask-image:linear-gradient(to_bottom,black_60%,transparent)]',
                )}
                data-agent-chat-question-body=""
            >
                <AgentChatMessage
                    className={cn('text-foreground', className)}
                    isStreaming={false}
                    text={text}
                />
            </div>
            {(isCut || isExpanded) && (
                <button
                    aria-expanded={isExpanded}
                    className="mt-1 block cursor-pointer border-0 bg-transparent p-0 text-[12px] text-muted hover:text-foreground focus-visible:rounded-sm focus-visible:outline focus-visible:outline-accent"
                    type="button"
                    onClick={() => setExpanded((value) => !value)}
                >
                    {t(isExpanded ? 'agentChat.message.showLess' : 'agentChat.message.showMore')}
                </button>
            )}
        </div>
    );
}
