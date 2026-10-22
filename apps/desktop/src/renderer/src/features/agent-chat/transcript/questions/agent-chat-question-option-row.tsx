import type { MouseEvent } from 'react';
import { useId } from 'react';

import type { AgentChatRequest } from '@caxri/protocol';
import { agentChatQuestionOption } from '@caxri/protocol';
import { ArrowRight, Check } from 'lucide-react';

import { Kbd } from '../../../../components/ui/kbd';
import { useTranslation } from '../../../../i18n';
import { cn } from '../../../../lib/utilities';

type QuestionOption = Extract<
    AgentChatRequest,
    { kind: 'question' }
>['questions'][number]['options'][number];

/**
 * One numbered answer row, a radio in a radio group, or a checkbox when the question takes several options. A click,
 * Enter, Space, or its digit answers with a radio row, as in the Codex app; a checkbox row toggles instead and the
 * footer sends. The selected row (the recommended option to start with, then wherever the arrow keys move) takes the
 * list's selection fill and an arrow, and a hovered row shows the same arrow, so either reads as "this answers"; the
 * recommended option also carries a badge that stays when the selection moves elsewhere.
 */
export function AgentChatQuestionOptionRow({
    buttonReference,
    isAnswering,
    isCheckbox,
    isFocusable,
    isSelected,
    number,
    onAnswer,
    option,
}: {
    buttonReference: (element: HTMLButtonElement | null) => void;
    isAnswering: boolean;
    /**
     * The question takes several options: the row is a checkbox and `isSelected` says it is ticked.
     */
    isCheckbox: boolean;
    /**
     * Roving tab stop: only the selected row (or the first, before any selection) is in the tab order.
     */
    isFocusable: boolean;
    isSelected: boolean;
    number: number;
    onAnswer: (event: MouseEvent<HTMLButtonElement>) => void;
    option: QuestionOption;
}) {
    const { t } = useTranslation();
    const { isRecommended, text } = agentChatQuestionOption(option.label);
    const descriptionId = useId();
    return (
        <button
            ref={buttonReference}
            aria-checked={isSelected}
            aria-describedby={option.description ? descriptionId : undefined}
            aria-keyshortcuts={number <= 9 ? String(number) : undefined}
            className={cn(
                'group/option flex w-full cursor-pointer items-start gap-2.5 rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-[13px] leading-5 text-foreground outline-none select-none focus-visible:shadow-[inset_0_0_0_1px_var(--accent)] disabled:opacity-50',
                isSelected
                    ? 'bg-list-active-selection-background text-list-active-selection-foreground'
                    : 'hover:bg-list-hover-background hover:text-list-hover-foreground',
            )}
            data-recommended={isRecommended || undefined}
            disabled={isAnswering}
            role={isCheckbox ? 'checkbox' : 'radio'}
            tabIndex={isFocusable ? 0 : -1}
            type="button"
            onClick={onAnswer}
        >
            {/* The digit is announced through `aria-keyshortcuts`, so the row's name starts with the option itself. */}
            <Kbd
                aria-hidden
                className={cn(
                    'mt-0.5 shrink-0 bg-transparent',
                    isSelected ? 'border-current text-current' : 'text-muted',
                )}
                size="compact"
            >
                {number}
            </Kbd>
            <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className={cn(isRecommended && 'font-semibold')}>{text}</span>
                    {isRecommended && (
                        <span className="rounded bg-muted/25 px-1.5 text-[10px] leading-4 font-semibold text-foreground">
                            {t('agentChat.request.recommended')}
                        </span>
                    )}
                </span>
                {option.description && (
                    <span
                        id={descriptionId}
                        className={cn(
                            'block text-[11px] leading-4',
                            isSelected ? 'opacity-75' : 'text-muted',
                        )}
                    >
                        {option.description}
                    </span>
                )}
            </span>
            {isCheckbox ? (
                <Check
                    aria-hidden
                    className={cn('size-3.5 shrink-0 self-center', !isSelected && 'invisible')}
                />
            ) : (
                <ArrowRight
                    aria-hidden
                    className={cn(
                        // Like the Codex app, the arrow centers on the whole row while the number stays with the title.
                        'size-3.5 shrink-0 self-center',
                        !isSelected && 'invisible group-hover/option:visible',
                    )}
                />
            )}
        </button>
    );
}
