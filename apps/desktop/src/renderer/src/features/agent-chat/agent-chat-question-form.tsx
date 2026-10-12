import type { KeyboardEvent } from 'react';
import { useId, useRef, useState } from 'react';

import type { AgentChatRequest, AgentChatResponse } from '@caxri/protocol';
import { agentChatQuestionOption } from '@caxri/protocol';
import { ArrowRight, Pencil, X } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Input, InputGroup } from '../../components/ui/input';
import { Kbd } from '../../components/ui/kbd';
import { Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/utilities';
import {
    answerAgentChatQuestion,
    questionOptionIndexForKey,
    recommendedQuestionOptionIndex,
} from './agent-chat-question-flow';

type QuestionRequest = Extract<AgentChatRequest, { kind: 'question' }>;
type QuestionOption = QuestionRequest['questions'][number]['options'][number];

/**
 * One numbered answer row, a radio in a radio group. A single click selects it; a double click, Enter, Space, or its
 * digit answers with it. The selected row takes the list's selection fill and an arrow, so it reads as "Submit sends
 * this"; the recommended option also carries an accent badge that stays when the selection moves elsewhere.
 */
function QuestionOptionRow({
    buttonReference,
    isAnswering,
    isFocusable,
    isSelected,
    number,
    onAnswer,
    onSelect,
    option,
}: {
    buttonReference: (element: HTMLButtonElement | null) => void;
    isAnswering: boolean;
    /**
     * Roving tab stop: only the selected row (or the first, before any selection) is in the tab order.
     */
    isFocusable: boolean;
    isSelected: boolean;
    number: number;
    onAnswer: () => void;
    onSelect: () => void;
    option: QuestionOption;
}) {
    const { isRecommended, text } = agentChatQuestionOption(option.label);
    const descriptionId = useId();
    return (
        <button
            ref={buttonReference}
            aria-checked={isSelected}
            aria-describedby={option.description ? descriptionId : undefined}
            aria-keyshortcuts={number <= 9 ? String(number) : undefined}
            className={cn(
                'flex w-full items-start gap-2.5 rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-[13px] leading-5 text-foreground outline-none select-none focus-visible:shadow-[inset_0_0_0_1px_var(--accent)] disabled:opacity-50',
                isSelected
                    ? 'bg-list-active-selection-background text-list-active-selection-foreground'
                    : 'hover:bg-list-hover-background hover:text-list-hover-foreground',
            )}
            data-recommended={isRecommended || undefined}
            disabled={isAnswering}
            role="radio"
            tabIndex={isFocusable ? 0 : -1}
            type="button"
            // `detail` is 0 for a keyboard click (Enter or Space), which answers like a double click does.
            onClick={(event) => (event.detail === 0 ? onAnswer() : onSelect())}
            onDoubleClick={onAnswer}
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
                        <span className="rounded-full bg-accent px-1.5 text-[10px] leading-4 font-semibold text-accent-foreground">
                            Recommended
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
            <ArrowRight
                aria-hidden
                className={cn('mt-0.5 size-3.5 shrink-0', !isSelected && 'invisible')}
            />
        </button>
    );
}

/**
 * A pending question, asked the way Codex asks one: a header naming who asks with a close button, the question, its
 * options as numbered rows, then one row with a free-text answer, Skip, and Submit. The recommended option starts
 * selected, so Submit alone accepts it. Several questions are asked one at a time with a `1/3` count: answering one
 * moves to the next, and the last sends them all. Close cancels the whole request; Skip passes over the current
 * question.
 */
export function AgentChatQuestionForm({
    isAnswering,
    providerName,
    request,
    respond,
    title,
}: {
    isAnswering: boolean;
    providerName: string;
    request: QuestionRequest;
    respond: (response: AgentChatResponse) => void;
    title: string;
}) {
    const [index, setIndex] = useState(0);
    const [answers, setAnswers] = useState<Record<string, string[]>>({});
    const [typed, setTyped] = useState('');
    const [selected, setSelected] = useState(() =>
        recommendedQuestionOptionIndex(request.questions.at(0)?.options ?? []),
    );
    const optionReferences = useRef<Array<HTMLButtonElement | null>>([]);
    const question = request.questions.at(index);
    const options = question?.options ?? [];
    const isLast = index + 1 >= request.questions.length;
    const answer = (value: string | undefined): void => {
        if (isAnswering) return;
        const step = answerAgentChatQuestion(request, answers, index, value);
        if (step.kind === 'respond') return respond(step.response);
        setAnswers(step.answers);
        setIndex(step.index);
        setTyped('');
        setSelected(
            recommendedQuestionOptionIndex(request.questions.at(step.index)?.options ?? []),
        );
    };
    const onOptionsKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        const picked = questionOptionIndexForKey(event.key, options.length);
        if (picked !== undefined) {
            event.preventDefault();
            answer(options[picked]?.label);
            return;
        }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const next = ((selected ?? (step === 1 ? -1 : 0)) + step + options.length) % options.length;
        setSelected(next);
        optionReferences.current[next]?.focus();
    };
    const typedAnswer = typed.trim();
    const selectedLabel = selected === undefined ? undefined : options[selected]?.label;
    const submitted = typedAnswer || selectedLabel;
    const allowsTyping = question !== undefined && (question.allowsOther || options.length === 0);
    return (
        <form
            className="space-y-2.5"
            onSubmit={(event) => {
                event.preventDefault();
                if (submitted) answer(submitted);
            }}
        >
            <div className="flex items-center gap-2">
                <h3 className="m-0 min-w-0 flex-1 truncate text-[11px] font-normal text-muted">
                    {title}
                </h3>
                {/* The title already says how many questions there are; this says which one is showing. */}
                {request.questions.length > 1 && (
                    <span
                        aria-label={`Question ${index + 1} of ${request.questions.length}`}
                        className="shrink-0 text-[11px] text-muted tabular-nums"
                    >
                        {index + 1}/{request.questions.length}
                    </span>
                )}
                <Tooltip content="Dismiss without answering">
                    <Button
                        aria-label="Dismiss question"
                        className="-my-1 -mr-1.5 size-6"
                        disabled={isAnswering}
                        size="icon"
                        variant="ghost"
                        onClick={() => respond({ kind: 'decision', decision: 'cancel' })}
                    >
                        <X aria-hidden className="size-3.5" />
                    </Button>
                </Tooltip>
            </div>
            {question && (
                <p className="m-0 text-[13px] leading-5 font-semibold text-foreground">
                    {question.header && (
                        <span className="mr-1.5 font-normal text-muted">{question.header}</span>
                    )}
                    {question.question}
                </p>
            )}
            {options.length > 0 && (
                <div
                    aria-label={question?.question}
                    className="-mx-2 flex flex-col gap-0.5"
                    role="radiogroup"
                    onKeyDown={onOptionsKeyDown}
                >
                    {options.map((option, optionIndex) => (
                        <QuestionOptionRow
                            buttonReference={(element) => {
                                optionReferences.current[optionIndex] = element;
                            }}
                            isAnswering={isAnswering}
                            isFocusable={optionIndex === (selected ?? 0)}
                            isSelected={optionIndex === selected && !typedAnswer}
                            key={option.label}
                            number={optionIndex + 1}
                            option={option}
                            onAnswer={() => answer(option.label)}
                            onSelect={() => {
                                setSelected(optionIndex);
                                setTyped('');
                            }}
                        />
                    ))}
                </div>
            )}
            <div className="flex items-center gap-2">
                {allowsTyping ? (
                    <InputGroup appearance="workbench" className="flex-1" size="dense">
                        <Pencil aria-hidden className="size-3.5 shrink-0 text-muted" />
                        <Input
                            appearance="embedded"
                            aria-label={`Other answer: ${question.question}`}
                            disabled={isAnswering}
                            placeholder={`Or tell ${providerName} something else`}
                            size="dense"
                            value={typed}
                            onChange={(event) => setTyped(event.target.value)}
                        />
                    </InputGroup>
                ) : (
                    <span className="flex-1 text-[11px] text-muted">
                        Double-click an option to answer
                    </span>
                )}
                <Button
                    disabled={isAnswering}
                    size="sm"
                    variant="ghost"
                    onClick={() => answer(undefined)}
                >
                    Skip
                </Button>
                <Button disabled={!submitted || isAnswering} size="sm" type="submit">
                    {isLast ? 'Submit' : 'Next'}
                </Button>
            </div>
        </form>
    );
}
