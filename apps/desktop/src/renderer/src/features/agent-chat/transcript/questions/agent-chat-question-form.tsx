import type { KeyboardEvent, MouseEvent, RefObject } from 'react';
import { useEffect, useId, useRef, useState } from 'react';

import type { AgentChatRequest, AgentChatResponse } from '@caxri/protocol';
import {
    agentChatNextUnansweredQuestion,
    agentChatQuestionAnswers,
    agentChatQuestionDefaults,
    agentChatQuestionOption,
} from '@caxri/protocol';
import { ArrowRight, Check } from 'lucide-react';

import { ChromeTabPanel, ChromeTabs } from '../../../../components/chrome-tabs';
import { Button } from '../../../../components/ui/button';
import { Input, InputGroup } from '../../../../components/ui/input';
import { Kbd } from '../../../../components/ui/kbd';
import { useTranslation } from '../../../../i18n';
import { cn } from '../../../../lib/utilities';
import type { QuestionFormPrimaryAction, QuestionPanelKeyAction } from './agent-chat-question-flow';
import {
    agentChatQuestionResponse,
    questionCardHeadings,
    questionFormPrimaryAction,
    questionPanelKeyAction,
} from './agent-chat-question-flow';
import { useAgentChatQuestionPicks } from './use-agent-chat-question-picks';

type QuestionRequest = Extract<AgentChatRequest, { kind: 'question' }>;
type QuestionOption = QuestionRequest['questions'][number]['options'][number];

/**
 * One numbered answer row, a radio in a radio group, or a checkbox when the question takes several options. A click,
 * Enter, Space, or its digit answers with a radio row, as in the Codex app; a checkbox row toggles instead and the
 * footer sends. The selected row (the recommended option to start with, then wherever the arrow keys move) takes the
 * list's selection fill and an arrow, and a hovered row shows the same arrow, so either reads as "this answers"; the
 * recommended option also carries a badge that stays when the selection moves elsewhere.
 */
function QuestionOptionRow({
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
                        <span className="rounded bg-elevated px-1.5 text-[10px] leading-4 font-semibold text-foreground">
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

/**
 * The `Q1 Q2 Q3` tab strip over several questions. A tab's check marks a question that already has an answer the user
 * has seen, and its accessible name carries the full question so a screen reader does not hear only `Q2`. A recommended
 * default on a question never opened earns no check: two checks on a card whose second question nobody read made the
 * card look finished.
 */
function QuestionTabStrip({
    answers,
    seen,
    idPrefix,
    index,
    onIndexChange,
    request,
}: {
    answers: Readonly<Record<string, string[]>>;
    seen: ReadonlySet<number>;
    idPrefix: string;
    index: number;
    onIndexChange: (index: number) => void;
    request: QuestionRequest;
}) {
    const { t } = useTranslation();
    return (
        <ChromeTabs
            ariaLabel={t('agentChat.request.questions')}
            className="-mx-1 flex"
            idPrefix={idPrefix}
            items={request.questions.map((item, itemIndex) => {
                const isItemAnswered = seen.has(itemIndex) && Object.hasOwn(answers, item.id);
                return {
                    value: String(itemIndex),
                    label: t('agentChat.request.questionTabLabel', {
                        index: itemIndex + 1,
                        count: request.questions.length,
                        question: item.header || item.question,
                    }),
                    description: t(
                        isItemAnswered
                            ? 'agentChat.request.answered'
                            : 'agentChat.request.unanswered',
                    ),
                    content: (
                        <>
                            {t('agentChat.request.questionTab', { index: itemIndex + 1 })}
                            <Check
                                aria-hidden
                                className={cn(
                                    'size-3 text-success',
                                    !isItemAnswered && 'invisible',
                                )}
                            />
                        </>
                    ),
                };
            })}
            tabClassName="h-7 px-2 text-[11px]"
            value={String(index)}
            onValueChange={(value) => onIndexChange(Number(value))}
        />
    );
}

/**
 * The free-text answer, numbered after the options so its digit focuses it the way an option's digit answers.
 */
function TypedAnswerRow({
    inputReference,
    isAnswering,
    onChange,
    optionCount,
    providerName,
    question,
    value,
}: {
    inputReference: RefObject<HTMLInputElement | null>;
    isAnswering: boolean;
    onChange: (value: string) => void;
    optionCount: number;
    providerName: string;
    question: string;
    value: string;
}) {
    const { t } = useTranslation();
    return (
        <div className="-mx-2 flex items-center gap-2.5 px-2">
            {optionCount > 0 && (
                <Kbd aria-hidden className="shrink-0 bg-transparent text-muted" size="compact">
                    {optionCount + 1}
                </Kbd>
            )}
            <InputGroup appearance="workbench" className="flex-1" size="dense">
                <Input
                    ref={inputReference}
                    appearance="embedded"
                    aria-keyshortcuts={
                        optionCount > 0 && optionCount < 9 ? String(optionCount + 1) : undefined
                    }
                    aria-label={t('agentChat.request.otherAnswerFor', { question })}
                    disabled={isAnswering}
                    placeholder={t('agentChat.request.otherAnswerPlaceholder', {
                        provider: providerName,
                    })}
                    size="dense"
                    value={value}
                    onChange={(event) => onChange(event.target.value)}
                />
            </InputGroup>
        </div>
    );
}

/**
 * Skip dismisses the whole request. The primary button reads Next while a question the user has not opened is still
 * unanswered, and Submit once there is none; Submit sends whatever is answered and shows the Enter hint only when Enter
 * would send rather than move to the next question.
 */
function QuestionFormFooter({
    canSubmit,
    isAnswering,
    isEnterSends,
    onNext,
    onSkip,
    onSubmit,
    primaryAction,
}: {
    canSubmit: boolean;
    isAnswering: boolean;
    isEnterSends: boolean;
    onNext: (index: number) => void;
    onSkip: () => void;
    onSubmit: () => void;
    primaryAction: QuestionFormPrimaryAction;
}) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center justify-end gap-2">
            <Button
                aria-keyshortcuts="Escape"
                disabled={isAnswering}
                size="sm"
                variant="ghost"
                onClick={onSkip}
            >
                {t('agentChat.request.skip')}
                <Kbd aria-hidden className="bg-transparent text-muted" size="compact">
                    Esc
                </Kbd>
            </Button>
            {primaryAction.kind === 'next' ? (
                <Button
                    disabled={isAnswering}
                    size="sm"
                    onClick={() => onNext(primaryAction.index)}
                >
                    {t('agentChat.request.next')}
                </Button>
            ) : (
                <Button
                    aria-keyshortcuts={isEnterSends ? 'Enter' : undefined}
                    disabled={!canSubmit || isAnswering}
                    size="sm"
                    onClick={onSubmit}
                >
                    {t('agentChat.request.submit')}
                    {isEnterSends && (
                        <Kbd aria-hidden className="border-current bg-transparent" size="compact">
                            ↵
                        </Kbd>
                    )}
                </Button>
            )}
        </div>
    );
}

/**
 * A pending question. Several questions sit behind `Q1 Q2 Q3` tabs, one question at a time, so the card stays the
 * height of one question however many are asked and every question stays one click away: a tab carries a check once its
 * question has an answer. Options are numbered rows and a free-text answer, when allowed, is the last numbered row.
 * Answering a question (a click, Enter, or its digit) moves to the next question still unanswered, and answering the
 * last one sends them all. A question the user has not opened always comes next, even when its recommended option
 * already answers it, so a click on the first question never sends answers to questions nobody read. While any question
 * is still unopened the primary button reads Next and opens it, so a submission never records an unseen question as
 * skipped or accepts its default unread; after that, Submit sends whatever is answered. The recommended option starts
 * selected, so Next through to Submit accepts every recommendation. Skip (or Esc) dismisses the whole request.
 *
 * A `multiSelect` question lists checkboxes instead: a click, Space, or a digit ticks an option, and Enter or the
 * primary button moves on with every ticked option (plus a typed answer, when there is one).
 */
export function AgentChatQuestionForm({
    isAnswering,
    isPointerSelect = false,
    onEscape,
    providerName,
    request,
    respond,
    title,
}: {
    isAnswering: boolean;
    /**
     * Runs on Escape instead of skipping the request, for a card whose surface owns Escape (the waiting popup folds).
     */
    onEscape?: () => void;
    /**
     * A click on an option only selects it; Enter, a digit, or the primary button still answers. For a card that shows
     * up on its own (the waiting popup), where a click meant for whatever was under the pointer must not send an
     * answer. The Chat's own card keeps click-to-answer.
     */
    isPointerSelect?: boolean;
    providerName: string;
    request: QuestionRequest;
    respond: (response: AgentChatResponse) => void;
    title: string;
}) {
    const idPrefix = useId();
    const [index, setIndex] = useState(0);
    /**
     * Questions the user has opened. An unanswered question in this set was left blank on purpose; one outside it was
     * never seen, so the primary button offers Next to it instead of Submit.
     */
    const [seen, setSeen] = useState<ReadonlySet<number>>(() => new Set([0]));
    const openQuestion = (nextIndex: number): void => {
        setIndex(nextIndex);
        setSeen((current) => (current.has(nextIndex) ? current : new Set([...current, nextIndex])));
    };
    const [selected, setSelected] = useState(() => agentChatQuestionDefaults(request));
    const [typed, setTyped] = useState<Partial<Record<string, string>>>({});
    const optionReferences = useRef<Array<HTMLButtonElement | null>>([]);
    const inputReference = useRef<HTMLInputElement>(null);
    const panelReference = useRef<HTMLDivElement>(null);
    /**
     * Set when an answer from the keyboard moves to another question, so focus follows to that question instead of
     * dropping to the document body when the answered row unmounts. A pointer answer leaves focus alone.
     */
    const shouldFocusQuestion = useRef(false);
    const question = request.questions.at(index);
    const {
        picked,
        ticked,
        toggle: toggleOption,
    } = useAgentChatQuestionPicks(request, question?.id, isAnswering);
    const options = question?.options ?? [];
    const allowsTyping = question !== undefined && (question.allowsOther || options.length === 0);
    const isMulti = question?.multiSelect === true;
    const choices = { ...selected, ...picked };
    const { answers } = agentChatQuestionAnswers(request, choices, typed);
    const isAnswered = question !== undefined && Object.hasOwn(answers, question.id);
    const typedAnswer = question ? (typed[question.id]?.trim() ?? '') : '';
    /**
     * Enter sends the card only when answering this question leaves nothing else unanswered; otherwise it moves on, so
     * the Submit button shows the Enter hint only then.
     */
    const isEnterSends =
        isAnswered && agentChatNextUnansweredQuestion(request, answers, index, seen) === undefined;
    // A multiSelect question has ticked rows rather than one selected option.
    const selectedIndex = options.findIndex(
        (option) => !isMulti && !typedAnswer && option.label === selected[question?.id ?? ''],
    );

    useEffect(() => {
        if (!shouldFocusQuestion.current) return;
        shouldFocusQuestion.current = false;
        const target = optionReferences.current[Math.max(selectedIndex, 0)];
        (options.length > 0 ? target : inputReference.current)?.focus();
        // Only a question change moves focus; a selection change inside one question must not.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [index]);

    const advance = (
        nextSelected: Record<string, string>,
        nextTyped: Partial<Record<string, string>>,
    ): void => {
        if (isAnswering) return;
        const nextAnswers = agentChatQuestionAnswers(
            request,
            { ...nextSelected, ...picked },
            nextTyped,
        ).answers;
        const nextIndex = agentChatNextUnansweredQuestion(request, nextAnswers, index, seen);
        if (nextIndex === undefined) return respond(agentChatQuestionResponse(nextAnswers));
        shouldFocusQuestion.current =
            panelReference.current?.contains(document.activeElement) ?? false;
        setSelected(nextSelected);
        setTyped(nextTyped);
        openQuestion(nextIndex);
    };
    const withoutTyped = (): Partial<Record<string, string>> => {
        const rest = { ...typed };
        if (question) delete rest[question.id];
        return rest;
    };
    const answerWithOption = (label: string): void => {
        if (question) advance({ ...selected, [question.id]: label }, withoutTyped());
    };
    const selectOption = (label: string): void => {
        if (!question) return;
        setSelected((current) => ({ ...current, [question.id]: label }));
        setTyped(withoutTyped());
    };
    /**
     * A row's click. `detail` is 0 for a click the keyboard synthesized (Enter or Space on the focused row), which
     * answers even where a pointer click only selects.
     */
    const clickOption = (label: string, event: MouseEvent<HTMLButtonElement>): void => {
        if (isMulti) return toggleOption(label);
        if (isPointerSelect && event.detail > 0) return selectOption(label);
        answerWithOption(label);
    };
    const runKeyAction = (action: QuestionPanelKeyAction): void => {
        const option = 'index' in action ? options.at(action.index) : undefined;
        if (action.kind === 'advance') {
            if (isAnswered) advance(selected, typed);
        } else if (action.kind === 'typed') {
            if (allowsTyping) inputReference.current?.focus();
        } else if (option && action.kind === 'pick') {
            if (isMulti) toggleOption(option.label);
            else answerWithOption(option.label);
        } else if (action.kind === 'move') {
            if (option && !isMulti) selectOption(option.label);
            optionReferences.current[action.index]?.focus();
        }
    };
    const onPanelKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
        const action = questionPanelKeyAction(event.key, {
            cursor: isMulti
                ? optionReferences.current.indexOf(document.activeElement as HTMLButtonElement)
                : selectedIndex,
            isIgnored:
                event.metaKey ||
                event.ctrlKey ||
                event.altKey ||
                event.target instanceof HTMLInputElement,
            isMulti,
            optionCount: options.length,
        });
        if (!action) return;
        event.preventDefault();
        runKeyAction(action);
    };
    const optionList = (
        <div
            aria-label={question?.question}
            className="-mx-2 flex flex-col gap-0.5"
            role={isMulti ? 'group' : 'radiogroup'}
        >
            {options.map((option, optionIndex) => (
                <QuestionOptionRow
                    buttonReference={(element) => {
                        optionReferences.current[optionIndex] = element;
                    }}
                    isAnswering={isAnswering}
                    isCheckbox={isMulti}
                    isFocusable={optionIndex === Math.max(selectedIndex, 0)}
                    isSelected={isMulti ? ticked.has(option.label) : optionIndex === selectedIndex}
                    key={option.label}
                    number={optionIndex + 1}
                    option={option}
                    onAnswer={(event) => clickOption(option.label, event)}
                />
            ))}
        </div>
    );
    const headings = questionCardHeadings(title, request.questions.length, question?.header);
    const questionBody = question && (
        <div ref={panelReference} className="space-y-2" onKeyDown={onPanelKeyDown}>
            <div className="space-y-0.5">
                {headings.questionHeader && (
                    <p className="m-0 text-[11px] leading-4 text-muted">
                        {headings.questionHeader}
                    </p>
                )}
                <p className="m-0 text-[13px] leading-5 font-semibold text-foreground">
                    {question.question}
                </p>
            </div>
            {options.length > 0 && optionList}
            {allowsTyping && (
                <TypedAnswerRow
                    inputReference={inputReference}
                    isAnswering={isAnswering}
                    optionCount={options.length}
                    providerName={providerName}
                    question={question.question}
                    value={typed[question.id] ?? ''}
                    onChange={(value) =>
                        setTyped((current) => ({ ...current, [question.id]: value }))
                    }
                />
            )}
        </div>
    );
    return (
        <form
            className="space-y-2"
            onKeyDown={(event) => {
                if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
                event.preventDefault();
                event.stopPropagation();
                if (onEscape) onEscape();
                else if (!isAnswering) respond({ kind: 'decision', decision: 'cancel' });
            }}
            onSubmit={(event) => {
                // Enter in the free-text row answers this question, the way Enter on an option row does.
                event.preventDefault();
                if (isAnswered) advance(selected, typed);
            }}
        >
            <h3 className="m-0 truncate text-[11px] font-normal text-muted">{headings.title}</h3>
            {request.questions.length > 1 ? (
                <>
                    <QuestionTabStrip
                        answers={answers}
                        seen={seen}
                        idPrefix={idPrefix}
                        index={index}
                        request={request}
                        onIndexChange={openQuestion}
                    />
                    <ChromeTabPanel active idPrefix={idPrefix} value={String(index)}>
                        {questionBody}
                    </ChromeTabPanel>
                </>
            ) : (
                questionBody
            )}
            <QuestionFormFooter
                canSubmit={Object.keys(answers).length > 0}
                isAnswering={isAnswering}
                isEnterSends={isEnterSends}
                primaryAction={questionFormPrimaryAction(request.questions.length, index, seen)}
                onNext={(nextIndex) => {
                    shouldFocusQuestion.current = true;
                    openQuestion(nextIndex);
                }}
                onSkip={() => respond({ kind: 'decision', decision: 'cancel' })}
                onSubmit={() => respond(agentChatQuestionResponse(answers))}
            />
        </form>
    );
}
