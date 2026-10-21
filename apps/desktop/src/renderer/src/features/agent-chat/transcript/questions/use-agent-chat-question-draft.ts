import { useState } from 'react';

import type { AgentChatRequest } from '@caxri/protocol';
import {
    agentChatQuestionDefaults,
    agentChatQuestionMultiDefaults,
    toggleAgentChatQuestionOption,
} from '@caxri/protocol';

import { createStore } from '../../../../lib/store';

type QuestionRequest = Extract<AgentChatRequest, { kind: 'question' }>;

/**
 * A question card's progress before it is sent: the open question, the questions opened so far, and each question's
 * chosen option, typed answer, and ticked `multiSelect` options.
 */
export interface AgentChatQuestionDraft {
    index: number;
    seen: readonly number[];
    selected: Readonly<Record<string, string>>;
    typed: Readonly<Partial<Record<string, string>>>;
    picked: Readonly<Record<string, readonly string[]>>;
}

/**
 * Drafts of unanswered question cards, per Chat Terminal and request. The waiting popup and the Chat's own card show
 * the same request, so an answer picked in the popup is still picked when the user opens the Session instead of
 * starting the card over. Memory only, and dropped once the card sends its answer or skips.
 */
const useAgentChatQuestionDrafts = createStore<{
    drafts: Readonly<Partial<Record<string, AgentChatQuestionDraft>>>;
}>('agentChatQuestionDrafts', () => ({ drafts: {} }));

function initialDraft(request: QuestionRequest): AgentChatQuestionDraft {
    return {
        index: 0,
        seen: [0],
        selected: agentChatQuestionDefaults(request),
        typed: {},
        picked: agentChatQuestionMultiDefaults(request),
    };
}

/**
 * The draft of `request` in `terminalId`'s Chat, shared by every card showing it. `update` applies to the latest stored
 * draft; `discard` forgets it once the answer leaves.
 */
export function useAgentChatQuestionDraft(
    terminalId: string,
    request: QuestionRequest,
): {
    draft: AgentChatQuestionDraft;
    update: (change: (draft: AgentChatQuestionDraft) => AgentChatQuestionDraft) => void;
    discard: () => void;
} {
    const key = agentChatQuestionDraftKey(terminalId, request.id);
    const stored = useAgentChatQuestionDrafts((state) => state.drafts[key]);
    const [initial] = useState(() => initialDraft(request));
    return {
        draft: stored ?? initial,
        update: (change) => updateAgentChatQuestionDraft(key, initial, change),
        discard: () => discardAgentChatQuestionDraft(key),
    };
}

export function agentChatQuestionDraftKey(terminalId: string, requestId: string): string {
    return `${terminalId}\u{0}${requestId}`;
}

export function readAgentChatQuestionDraft(key: string): AgentChatQuestionDraft | undefined {
    return useAgentChatQuestionDrafts.getState().drafts[key];
}

export function updateAgentChatQuestionDraft(
    key: string,
    initial: AgentChatQuestionDraft,
    change: (draft: AgentChatQuestionDraft) => AgentChatQuestionDraft,
): void {
    useAgentChatQuestionDrafts.setState(({ drafts }) => ({
        drafts: { ...drafts, [key]: change(drafts[key] ?? initial) },
    }));
}

export function discardAgentChatQuestionDraft(key: string): void {
    useAgentChatQuestionDrafts.setState(({ drafts }) => ({
        drafts: Object.fromEntries(Object.entries(drafts).filter(([draftKey]) => draftKey !== key)),
    }));
}

const NO_TICKS: ReadonlySet<string> = new Set();

/**
 * The ticked options of the open `multiSelect` question, starting from its recommended option the way a single-choice
 * question starts selected on it. `toggle` does nothing while an answer is in flight.
 */
export function agentChatQuestionTicks(
    draft: AgentChatQuestionDraft,
    update: (change: (draft: AgentChatQuestionDraft) => AgentChatQuestionDraft) => void,
    questionId: string | undefined,
    isAnswering: boolean,
): { ticked: ReadonlySet<string>; toggle: (label: string) => void } {
    const current = questionId === undefined ? undefined : draft.picked[questionId];
    return {
        ticked: current ? new Set(current) : NO_TICKS,
        toggle: (label) => {
            if (questionId === undefined || isAnswering) return;
            update((state) => ({
                ...state,
                picked: {
                    ...state.picked,
                    [questionId]: toggleAgentChatQuestionOption(
                        state.picked[questionId] ?? [],
                        label,
                    ),
                },
            }));
        },
    };
}
