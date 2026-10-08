import type { CaxriDatabase } from '../db';
import type { AgentEnvironment } from './contract';
import type { AgentLifecycleSignal } from './hooks/contract';
import { agentProviders } from './providers';
import { readAgentTranscript } from './transcript';

/**
 * Reconciles an about-to-be-applied `turnFinished` signal against the provider's own transcript before it becomes
 * durable state. Claude and Grok already classify their own failures through a native StopFailure-class hook event
 * (`hooks.ts`), so `resolvePrimaryTurnFailure` is a no-op for them; Codex has none (issue caxri#1345), so its `Stop`
 * hook alone cannot distinguish a login expiry or rate limit from an ordinary completed turn.
 *
 * A transcript read failure, a missing turn correlation, or a provider that does not implement
 * `resolvePrimaryTurnFailure` all leave the signal unchanged: this can only add a failed-turn classification the
 * transcript unambiguously proves, never invent one from an inconclusive read.
 */
export async function reconcilePrimaryTurnFailure(
    database: CaxriDatabase,
    environment: AgentEnvironment,
    signal: AgentLifecycleSignal,
): Promise<AgentLifecycleSignal> {
    if (signal.phase !== 'turnFinished' || !signal.agentTurnId) return signal;
    const resolve = agentProviders[signal.provider].resolvePrimaryTurnFailure;
    if (!resolve) return signal;
    try {
        const transcript = await readAgentTranscript(
            database,
            signal.terminalId,
            true,
            environment,
        );
        if (!transcript?.exists || !transcript.content) return signal;
        const agentFailure = resolve(transcript.content, signal.agentTurnId);
        if (!agentFailure) return signal;
        return { ...signal, phase: 'turnFailed', agentFailure };
    } catch {
        // A transcript read is best-effort reconciliation, never a gate on the hook signal itself.
        return signal;
    }
}
