import { useMemo } from 'react';

import type { AgentExcerpt, SessionRecord } from '@caxri/protocol';
import { AGENT_EXCERPT_MAX_SESSIONS } from '@caxri/protocol';

import { useCaxriQuery } from '../queries/client';

const NO_EXCERPTS: Readonly<Partial<Record<string, AgentExcerpt>>> = {};

/**
 * What the Primary Agent of each Session last asked or said, for the Session hover card and Activity rows. The answer
 * is asked per attention generation, so it refreshes exactly when a Session's attention moves on; the Server reads the
 * pending request from a live Chat or the on-disk transcript and never starts a provider. Excerpts are user content
 * held only in the query cache: nothing here writes them to storage or logs.
 */
export function useSessionExcerpts(
    sessions: ReadonlyArray<Pick<SessionRecord, 'attentionEpoch' | 'id'>>,
    isEnabled = true,
): Readonly<Partial<Record<string, AgentExcerpt>>> {
    const asked = useMemo(
        () =>
            sessions
                .slice(0, AGENT_EXCERPT_MAX_SESSIONS)
                .map(({ attentionEpoch, id }) => ({ attentionEpoch, sessionId: id })),
        [sessions],
    );
    const query = useCaxriQuery(
        'agent.excerpts',
        { sessions: asked },
        { enabled: isEnabled && asked.length > 0, staleTime: 30_000 },
    );
    return query.data?.excerpts ?? NO_EXCERPTS;
}
