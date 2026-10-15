import type { AgentProvider } from '@caxri/protocol';

import type { AgentLifecyclePhase, AgentSignalIgnoredReason } from './contract';

export type AgentHookSignalRejectionReason =
    | 'downstreamRejected'
    | 'invalidAgentCwd'
    | 'invalidAgentId'
    | 'invalidAgentSessionId'
    | 'invalidAgentToolUseId'
    | 'invalidAgentTurnId'
    | 'invalidAgentDigest'
    | 'invalidJson'
    | 'invalidSignal'
    | 'launchMismatch'
    | 'payloadTooLarge'
    | 'providerMismatch'
    | 'schemaMismatch'
    | 'terminalMismatch'
    | 'transportError'
    | 'transportTimeout'
    | 'unknownToken';

/**
 * Outcome of applying one authenticated signal downstream. An ignored signal always names its reason: an unexplained
 * drop reads identically to a lost hook in the log, which is the failure this contract exists to prevent.
 */
export type AgentHookSignalResult =
    | { disposition: 'accepted'; context?: string }
    | { disposition: 'rejected' }
    | { disposition: 'ignored'; reason: AgentSignalIgnoredReason };

/**
 * Existence-only detail about the identifiers a signal carried. The values themselves stay on the provider's side of
 * the boundary; only whether they were present crosses into diagnostics.
 */
export interface AgentHookSignalPresence {
    hasAgentCwd?: boolean;
    hasAgentSessionId?: boolean;
    hasAgentTurnId?: boolean;
    worktreeCreateIntent?: boolean;
}

export type AgentHookSignalDiagnostic =
    | {
          outcome: 'started';
          phase: AgentLifecyclePhase;
          provider: AgentProvider;
          terminalId: string;
      }
    | (AgentHookSignalPresence & {
          /**
           * Server-side handling cost for this signal, from the first received byte to the settled disposition. The
           * bridge abandons the connection after its own 2s socket timeout, so this is the measurement that says how
           * much headroom is left before signals start being lost to that timeout.
           */
          handlingMs?: number;
          outcome: 'accepted';
          phase: AgentLifecyclePhase;
          provider: AgentProvider;
          terminalId: string;
      })
    | (AgentHookSignalPresence & {
          handlingMs?: number;
          outcome: 'ignored';
          phase?: AgentLifecyclePhase;
          provider: AgentProvider;
          reason: AgentSignalIgnoredReason;
          /**
           * Bounded wire token when `reason` is `unknownPhase`. Never used as a metric label.
           */
          receivedPhase?: string;
          terminalId: string;
      })
    | (AgentHookSignalPresence & {
          handlingMs?: number;
          outcome: 'rejected';
          phase?: AgentLifecyclePhase;
          provider?: AgentProvider;
          reason: AgentHookSignalRejectionReason;
          receivedPhase?: string;
          terminalId?: string;
      });
