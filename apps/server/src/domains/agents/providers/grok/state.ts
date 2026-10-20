import { join } from 'node:path';

import { sessionRenameTitleSchema } from '@caxri/protocol';
import { readBoundedRegularFileText } from '@caxri/system';

import type { AgentEnvironment, AgentSnapshotContext, LocalAgentState } from '../../contract';
import { canonicalPath, isOpaqueAgentSessionId } from '../../contract';
import { grokProjectRoot } from './paths';

/**
 * `summary.json` is a compact per-conversation record: about 1 KB in practice. A larger file is provider schema drift
 * rather than a title, so the probe stays bounded instead of parsing whatever grew there.
 */
const MAX_GROK_SUMMARY_BYTES = 64 * 1024;

interface GrokSessionSummary {
    generated_title?: unknown;
}

async function readGrokSummary(path: string): Promise<GrokSessionSummary | undefined> {
    try {
        const parsed: unknown = JSON.parse(
            await readBoundedRegularFileText(path, MAX_GROK_SUMMARY_BYTES),
        );
        return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
    } catch {
        /**
         * A conversation Grok Build has not flushed yet, an inaccessible home, an oversized or non-regular entry (the
         * shared reader refuses a FIFO instead of waiting on its writer), and a half-written or malformed record all
         * mean the same thing to the probe: no title to publish.
         */
        return undefined;
    }
}

/**
 * Reads only the conversation title Grok Build generated for itself, and only for the exact Agent session a validated
 * lifecycle hook already bound to this Terminal.
 *
 * Identity and activity stay hook-owned: directory recency cannot tell two simultaneous same-directory conversations
 * apart, so an unbound Terminal deliberately reads nothing, and a bound one reports no `sessionId` or `status` that
 * could overwrite the authenticated hook signal.
 *
 * `generated_title` is the output of Grok's own title generator, refreshed after later turns. Unlike Codex, Grok writes
 * no provisional raw-first-prompt placeholder into that field, so there is nothing to suppress here; see the title
 * rationale in `../codex/index.ts`.
 */
export async function readGrokState(
    context: AgentSnapshotContext,
    environment: AgentEnvironment,
): Promise<LocalAgentState | undefined> {
    const { agentSessionId } = context;
    if (!agentSessionId || !isOpaqueAgentSessionId(agentSessionId)) return undefined;
    const rootPath = await canonicalPath(context.rootPath);
    const projectRoot = await grokProjectRoot(rootPath, environment);
    if (!projectRoot) return undefined;
    const summary = await readGrokSummary(join(projectRoot, agentSessionId, 'summary.json'));
    /**
     * Provider metadata is untrusted model-written text that reaches the Session list, the Terminal tab, and native
     * notifications, so it must satisfy the same single-line, bounded contract as a user-entered Session name.
     */
    const title = sessionRenameTitleSchema.safeParse(summary?.generated_title);
    return title.success ? { title: title.data, titleSource: 'automatic' } : undefined;
}
