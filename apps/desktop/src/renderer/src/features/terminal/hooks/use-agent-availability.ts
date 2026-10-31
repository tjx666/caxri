import { useCaxriQuery } from '../../../queries/client';
import type { AgentReadiness } from '../new-terminal-agent';
import { agentReadinessIssues } from '../new-terminal-agent';

/**
 * A missing CLI rarely appears between two opens of the same menu, and the Server answers from its executable cache, so
 * a short stale window keeps repeated opens from re-asking while still noticing a fresh install within a minute.
 */
const AGENT_AVAILABILITY_STALE_MS = 30_000;

/**
 * The Agents that cannot start yet (CLI not found, or signed out) and why, read when a New Session or New Terminal
 * control opens. The probe resolves each configured executable and asks an installed CLI's status command (it starts no
 * conversation), and the Server caches both answers, so it is cheap. Empty until the answer arrives and when the
 * request fails: an annotation is a hint, never a gate on creating the Session.
 *
 * @param isEnabled Whether the control is open; a closed one does not ask.
 */
export function useAgentAvailability(isEnabled = true): AgentReadiness {
    const { data } = useCaxriQuery(
        'agentAvailability.get',
        {},
        {
            enabled: isEnabled,
            retry: false,
            select: agentReadinessIssues,
            staleTime: AGENT_AVAILABILITY_STALE_MS,
        },
    );
    return data ?? agentReadinessIssues(undefined);
}
