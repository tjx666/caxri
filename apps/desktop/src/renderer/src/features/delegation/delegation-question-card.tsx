import { useRef, useState } from 'react';

import type { AgentDelegationSession } from '@caxri/protocol';
import { MAX_ANSWER_TEXT_CHARS } from '@caxri/protocol';
import { LoaderCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import {
    clearDelegationAnswerDraft,
    getDelegationAnswerDraft,
    setDelegationAnswerDraft,
} from './delegation-answer-drafts';
import {
    canSendDelegationAnswer,
    delegationQuestionMode,
    delegationQuestionNoticeKey,
    delegationQuestionOptions,
    isDelegationAnswerSendKey,
} from './delegation-question';
import { useDelegationAnswer, useDelegationQuestion } from './hooks/use-delegation-question';

type QuestionCardEntry = Pick<AgentDelegationSession, 'delegationId' | 'takenOverAt' | 'waitingOn'>;

/**
 * The open question of a delegated Session, under its origin row: the question, its suggested answers, and an answer
 * field. While the delegating Agent still has the question (`offer`) only "I will answer" shows; once it escalated the
 * field is open and a note says why. The first answer wins, so a late one is refused with an inline note, not sent
 * twice. Renders nothing without an open question or after a takeover.
 *
 * The question text is read from the owner-only `questionDetail`, never from the feed, and only while the feed says one
 * is open.
 */
export function DelegationQuestionCard({
    className,
    entry,
    parentTitle,
}: {
    className?: string;
    entry: QuestionCardEntry;
    parentTitle: string;
}) {
    const { t } = useTranslation();
    const mode = delegationQuestionMode(entry);
    const { data: question } = useDelegationQuestion(entry.delegationId, mode !== 'hidden');
    const { data: result, isPending, mutate } = useDelegationAnswer();
    const [isOpen, setIsOpen] = useState(false);
    // The draft outlives the card (it unmounts on a Session switch), so it is kept per delegation, not in state alone.
    const [draft, setDraftState] = useState(() =>
        entry.delegationId === undefined ? '' : getDelegationAnswerDraft(entry.delegationId),
    );
    // Set only by "I will answer": an escalated card opens with its field and must not steal focus from the user.
    const shouldFocusField = useRef(false);
    if (mode === 'hidden' || !question || entry.delegationId === undefined) return null;
    const delegationId = entry.delegationId;
    const noticeKey = delegationQuestionNoticeKey(result?.outcome);
    const isFieldShown = mode === 'escalated' || isOpen;
    const options = delegationQuestionOptions(question);
    const setDraft = (value: string): void => {
        setDraftState(value);
        setDelegationAnswerDraft(delegationId, value);
    };
    const send = (): void => {
        if (isPending || !canSendDelegationAnswer(draft)) return;
        mutate(
            { delegationId, questionId: question.questionId, text: draft.trim() },
            { onSuccess: () => clearDelegationAnswerDraft(delegationId) },
        );
    };
    return (
        <div
            className={cn('flex min-w-0 flex-col gap-1.5', className)}
            data-delegation-question={mode}
        >
            {mode === 'escalated' && (
                <span className="text-warning">
                    {t('delegation.question.escalatedReason', { title: parentTitle })}
                </span>
            )}
            {/* Focusable so a keyboard user can scroll a question taller than the strip allows. */}
            <span
                aria-label={t('delegation.question.textLabel')}
                className="max-h-24 min-w-0 overflow-y-auto whitespace-pre-wrap text-foreground focus-visible:rounded-sm focus-visible:outline focus-visible:outline-accent"
                role="group"
                tabIndex={0}
            >
                {question.text}
            </span>
            {!isFieldShown && (
                <button
                    className="w-fit cursor-pointer border-0 bg-transparent p-0 text-left text-[12px] text-accent underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline focus-visible:outline-accent"
                    type="button"
                    onClick={() => {
                        shouldFocusField.current = true;
                        setIsOpen(true);
                    }}
                >
                    {t('delegation.question.answerAction')}
                </button>
            )}
            {isFieldShown && (
                <>
                    <span>{t('delegation.question.hint')}</span>
                    <Textarea
                        aria-label={t('delegation.question.placeholder')}
                        className="min-h-13"
                        maxLength={MAX_ANSWER_TEXT_CHARS}
                        placeholder={t('delegation.question.placeholder')}
                        ref={(node) => {
                            if (!(node && shouldFocusField.current)) {
                                return;
                            }

                            shouldFocusField.current = false;
                            node.focus();
                        }}
                        rows={2}
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={(event) => {
                            if (!isDelegationAnswerSendKey(event)) return;
                            event.preventDefault();
                            send();
                        }}
                    />
                    {/*
                     * Suggested answers share the Send row: the card sits in the composer strip's shared height cap, and
                     * an escalated question's extra line otherwise pushed Send below the visible part of the strip.
                     */}
                    <span className="flex flex-wrap items-center gap-1">
                        {options.length > 0 && (
                            <span
                                aria-label={t('delegation.question.optionsLabel')}
                                className="contents"
                                role="group"
                            >
                                {options.map((option) => (
                                    <Button
                                        key={option}
                                        size="sm"
                                        type="button"
                                        variant="secondary"
                                        onClick={() => setDraft(option)}
                                    >
                                        {option}
                                    </Button>
                                ))}
                            </span>
                        )}
                        <Button
                            className="ml-auto"
                            aria-busy={isPending}
                            disabled={isPending || !canSendDelegationAnswer(draft)}
                            size="sm"
                            type="button"
                            onClick={send}
                        >
                            {isPending && (
                                <LoaderCircle
                                    aria-hidden="true"
                                    className="size-3.5 animate-spin motion-reduce:animate-none"
                                />
                            )}
                            {t('delegation.question.send')}
                        </Button>
                    </span>
                    {noticeKey && <span role="status">{t(noticeKey)}</span>}
                </>
            )}
        </div>
    );
}
