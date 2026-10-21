/**
 * How long a handed-off query waits for its Chat to mount. Opening a Session renders its Chat within a frame or two; a
 * conversation shown as a PTY Terminal never registers, and a query left waiting must not open find when the user
 * switches that Terminal to Chat much later.
 */
const HANDOFF_TTL_MS = 15_000;

type AgentChatFindHandler = (query: string) => void;

const handlers = new Map<string, AgentChatFindHandler>();
/**
 * At most one query waits: a newer handoff replaces it.
 */
const pending = new Map<string, { query: string; expiresAt: number }>();

/**
 * Opens find in the Chat showing provider conversation `agentSessionId` with `query` and reveals its match, so a
 * Session search result lands on the message that matched. The Chat may not be mounted yet when its Session is just
 * being opened; the query then waits for it to register.
 */
export function handOffAgentChatFind(
    agentSessionId: string,
    query: string,
    now: number = Date.now(),
): void {
    const handler = handlers.get(agentSessionId);
    pending.clear();
    if (handler) handler(query);
    else pending.set(agentSessionId, { query, expiresAt: now + HANDOFF_TTL_MS });
}

/**
 * Registers the Chat showing `agentSessionId` as the receiver of a handed-off query, delivering one still waiting for
 * it.
 */
export function registerAgentChatFindHandoff(
    agentSessionId: string,
    handler: AgentChatFindHandler,
    now: number = Date.now(),
): () => void {
    handlers.set(agentSessionId, handler);
    const waiting = pending.get(agentSessionId);
    if (waiting) {
        pending.delete(agentSessionId);
        if (now <= waiting.expiresAt) handler(waiting.query);
    }
    return () => {
        if (handlers.get(agentSessionId) === handler) handlers.delete(agentSessionId);
    };
}
