import type { AgentProvider } from '@caxri/protocol';

import type { AgentEnvironment } from '../contract';
import type { IndexSearchRequest, IndexSearchResponse, IndexStatus } from './engine';
import type { IndexerPassReport } from './indexer';

export interface SessionSearchWorkerData {
    databasePath: string;
    environment: AgentEnvironment;
}

export interface InspectedConversation {
    cwd: string;
    title?: string;
    updatedAt: number;
}

/**
 * One conversation identity a `describe` request asks about.
 */
export interface ConversationIdentity {
    provider: AgentProvider;
    agentSessionId: string;
}

export type SessionSearchWorkerRequest =
    | { id: number; type: 'search'; request: IndexSearchRequest }
    | { id: number; type: 'inspect'; provider: AgentProvider; agentSessionId: string }
    /**
     * Reads indexed titles for known conversations without touching their transcripts or starting an index pass.
     */
    | { id: number; type: 'describe'; conversations: ConversationIdentity[] }
    /**
     * Drops a queued search whose caller gave up, so fast typing does not leave a backlog of substring scans.
     */
    | { id: number; type: 'cancel' };

export type SessionSearchWorkerReply =
    | { type: 'search'; id: number; response: IndexSearchResponse }
    | { type: 'inspect'; id: number; conversation: InspectedConversation | undefined }
    /**
     * Index titles aligned with the request's `conversations`; `undefined` where the index has none.
     */
    | { type: 'describe'; id: number; titles: Array<string | undefined> }
    /**
     * A request failed. Only a closed reason crosses the boundary: an exception message could quote a path or a title.
     */
    | { type: 'error'; id: number; reason: 'failed' }
    /**
     * The index could not be opened; the Worker exits after posting this.
     */
    | { type: 'unavailable' }
    | { type: 'pass'; report: IndexerPassReport; status: IndexStatus }
    | { type: 'passFailed'; status: IndexStatus };
