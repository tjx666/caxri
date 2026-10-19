import type { AgentChatRequest } from '@caxri/protocol';
import { agentChatNextUnansweredQuestion } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';

type QuestionRequest = Extract<AgentChatRequest, { kind: 'question' }>;

/**
 * Which pending request the phone's dock shows. The dock shows one card at a time so a phone never stacks several full
 * cards into one scrolling block: the first request still waiting for an answer, with a `1 of N` label while others
 * wait behind it. A request whose answer is on its way does not count, so the next one takes its place at once.
 */
export interface AgentChatRequestDock {
    /**
     * The request the dock shows, or `undefined` when every request is answered or there are none.
     */
    currentId: string | undefined;
    /**
     * `1 of N` when more than one request waits; `undefined` for a single request.
     */
    positionLabel: string | undefined;
}

export function agentChatRequestDock(
    requests: readonly AgentChatRequest[],
    answeredRequestIds: ReadonlySet<string>,
    t: Translate = translate,
): AgentChatRequestDock {
    const waiting = requests.filter((request) => !answeredRequestIds.has(request.id));
    return {
        currentId: waiting.at(0)?.id,
        positionLabel:
            waiting.length > 1
                ? t('chat.request.position', { count: waiting.length, index: 1 })
                : undefined,
    };
}

/**
 * The question card's footer beside Skip.
 *
 * - One question with options and no typed answer has no Submit: a tap on an option sends it, so a Submit would only
 *   repeat what the tap already did.
 * - One question answered by typing (a free-text question, or a typed "Other") shows Submit.
 * - Several questions step with Back and Next; the last question, or any question once every question has been opened and
 *   has an answer, shows Submit instead of Next. A recommended default does not count until its question was opened, so
 *   Submit never sends an answer the user has not read.
 */
export interface AgentChatQuestionFooter {
    isBackShown: boolean;
    /**
     * The trailing button: `next` moves to the following question, `submit` sends every answer so far, and `undefined`
     * means a tap on an option sends.
     */
    primary: 'next' | 'submit' | undefined;
    /**
     * Submit needs at least one answer; the provider decides how to treat a question left unanswered.
     */
    canSubmit: boolean;
}

export function agentChatQuestionFooter({
    answers,
    index,
    request,
    seen,
    typed,
}: {
    answers: Readonly<Record<string, readonly string[]>>;
    index: number;
    request: QuestionRequest;
    /**
     * Indexes of the questions the user has opened.
     */
    seen: ReadonlySet<number>;
    typed: Readonly<Record<string, string | undefined>>;
}): AgentChatQuestionFooter {
    const count = request.questions.length;
    const question = request.questions.at(index);
    const canSubmit = Object.keys(answers).length > 0;
    if (count <= 1) {
        const isTapSends =
            question !== undefined && question.options.length > 0 && !typed[question.id]?.trim();
        return { isBackShown: false, primary: isTapSends ? undefined : 'submit', canSubmit };
    }
    const isComplete = request.questions.every(
        (item, itemIndex) => seen.has(itemIndex) && Object.hasOwn(answers, item.id),
    );
    return {
        isBackShown: index > 0,
        primary: isComplete || index >= count - 1 ? 'submit' : 'next',
        canSubmit,
    };
}

/**
 * Where answering the question at `index` leads: the next question still unanswered or never opened, or `send` when
 * none is left. Answering a question by tap or by the keyboard's send key both go through this, so the keyboard's
 * return key can say up front whether it sends or moves on.
 */
export function agentChatQuestionAdvance(
    request: QuestionRequest,
    answers: Readonly<Record<string, readonly string[]>>,
    index: number,
    seen: ReadonlySet<number>,
): { kind: 'move'; index: number } | { kind: 'send' } {
    const next = agentChatNextUnansweredQuestion(request, answers, index, seen);
    return next === undefined ? { kind: 'send' } : { kind: 'move', index: next };
}
