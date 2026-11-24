import type { AgentEnvironment } from '../contract';
import type { ConversationExclusionReason } from '../external-conversation-parsers';
import type { AntigravityReadFailureReason } from '../providers/antigravity/conversation-database';
import {
    ANTIGRAVITY_SUBAGENT_SOURCE,
    readAntigravityConversationHeadResult,
    readAntigravityConversationSummaryResult,
} from '../providers/antigravity/conversation-database';

/**
 * Maps a failed database read to the exclusion the index pass counts. `locked` is transient (the indexer retries it),
 * `schemaChanged` and `corrupt` are lasting; any other failure keeps the caller's `fallback`.
 */
export function antigravityReadExclusion(
    reason: AntigravityReadFailureReason,
    fallback: ConversationExclusionReason,
): ConversationExclusionReason {
    switch (reason) {
        case 'locked':
            return 'locked';
        case 'schema':
            return 'schemaChanged';
        case 'corrupt':
            return 'corrupt';
        default:
            return fallback;
    }
}

export interface AntigravityCandidateRead {
    cwd?: string;
    title?: string;
    firstPrompt?: string;
}

/**
 * Antigravity keeps the folder and its generated title in `conversation_summaries.db` and the conversation itself in
 * `conversations/<id>.db`; see `conversation-database.ts`. A conversation a parent spawned as a subagent is not one the
 * user had. A failed read names its closed exclusion instead of reading as "no conversation".
 */
export function readAntigravityCandidate(
    path: string,
    environment: AgentEnvironment,
    conversationId: string,
): AntigravityCandidateRead | ConversationExclusionReason {
    const headRead = readAntigravityConversationHeadResult(path);
    if (!headRead.ok) return antigravityReadExclusion(headRead.reason, 'unreadable');
    const head = headRead.value;
    if (head.source === ANTIGRAVITY_SUBAGENT_SOURCE) return 'sidechain';
    const summaryRead = readAntigravityConversationSummaryResult(environment, conversationId);
    if (!summaryRead.ok) return antigravityReadExclusion(summaryRead.reason, 'missingMetadata');
    const summary = summaryRead.value;
    if (!summary) return 'missingMetadata';
    return {
        ...(summary.cwd !== undefined && { cwd: summary.cwd }),
        ...(summary.title !== undefined && { title: summary.title }),
        ...(head.firstPrompt !== undefined && { firstPrompt: head.firstPrompt }),
    };
}
