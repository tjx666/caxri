import type { AgentAction } from '@caxri/protocol';

import type { SuggestionOption } from '../../lib/suggestion-options';
import type { SessionReferenceCandidate } from '../session/session-reference';

export function agentChatActionSuggestion(action: AgentAction): SuggestionOption {
    return {
        key: action.invocation,
        label: action.invocation,
        isLabelLiteral: true,
        ...(action.argumentHint && { hint: action.argumentHint }),
        ...(action.description && { description: action.description }),
    };
}

export function agentChatSessionSuggestion(candidate: SessionReferenceCandidate): SuggestionOption {
    return {
        key: `session-${candidate.sessionId}`,
        label: candidate.title,
        isLabelLiteral: false,
        ...(candidate.projectTitle && { description: candidate.projectTitle }),
    };
}
