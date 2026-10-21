import { useState } from 'react';

import type { AgentChatRequest } from '@caxri/protocol';
import { agentChatQuestionMultiDefaults, toggleAgentChatQuestionOption } from '@caxri/protocol';

type QuestionRequest = Extract<AgentChatRequest, { kind: 'question' }>;

const NO_TICKS: ReadonlySet<string> = new Set();

/**
 * The ticked options of each `multiSelect` question in a question card, starting from its recommended option the way a
 * single-choice question starts selected on it. `ticked` is the open question's set; `toggle` does nothing while an
 * answer is in flight.
 */
export function useAgentChatQuestionPicks(
    request: QuestionRequest,
    questionId: string | undefined,
    isAnswering: boolean,
): {
    picked: Readonly<Record<string, readonly string[]>>;
    ticked: ReadonlySet<string>;
    toggle: (label: string) => void;
} {
    const [picked, setPicked] = useState<Readonly<Record<string, readonly string[]>>>(() =>
        agentChatQuestionMultiDefaults(request),
    );
    const current = questionId === undefined ? undefined : picked[questionId];
    return {
        picked,
        ticked: current ? new Set(current) : NO_TICKS,
        toggle: (label) => {
            if (questionId === undefined || isAnswering) return;
            setPicked((state) => ({
                ...state,
                [questionId]: toggleAgentChatQuestionOption(state[questionId] ?? [], label),
            }));
        },
    };
}
