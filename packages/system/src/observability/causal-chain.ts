import type { ObservationContext } from './context.js';
import { normalizeObservationContext } from './context.js';
import type { ObservationOwner, ObservationPhase } from './metrics.js';

export const failureReasons = [
    'capacity',
    'control-unreachable',
    'core-unavailable',
    'extension-host-exited',
    'invalid-message',
    'persistence-unavailable',
    'stream-closed',
    'terminal-host-exited',
    'timeout',
    'unknown',
] as const;

export const remediationCategories = [
    'inspect-artifact',
    'none',
    'reconnect',
    'reduce-load',
    'repair-persistence',
    'restart-core',
    'restart-extension-host',
    'restart-terminal-host',
    'retry',
] as const;

export type FailureReason = (typeof failureReasons)[number];
export type RemediationCategory = (typeof remediationCategories)[number];

export interface CausalCapsuleInput {
    code?: string;
    context?: ObservationContext;
    owner: ObservationOwner;
    phase: ObservationPhase;
    reason: FailureReason;
    remediation: RemediationCategory;
    retryable: boolean;
    timestamp?: string;
}

export interface CausalCapsule {
    code?: string;
    context: ObservationContext;
    owner: ObservationOwner;
    phase: ObservationPhase;
    reason: FailureReason;
    remediation: RemediationCategory;
    retryable: boolean;
    schemaVersion: 1;
    timestamp: string;
}

export const MAX_CAUSAL_CAPSULES = 128;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;

/**
 * A bounded content-free lifecycle. There is deliberately no message, stack, payload, path, command parameters, or
 * environment field: diagnostics can classify ownership and remediation without retaining user-authored content.
 */
export class BoundedCausalChain {
    private readonly capsules: CausalCapsule[] = [];

    record(input: CausalCapsuleInput): CausalCapsule {
        const capsule: CausalCapsule = {
            schemaVersion: 1,
            timestamp: input.timestamp ?? new Date().toISOString(),
            owner: input.owner,
            phase: input.phase,
            reason: input.reason,
            remediation: input.remediation,
            retryable: input.retryable,
            context: normalizeObservationContext(input.context ?? {}),
            ...(input.code && SAFE_CODE.test(input.code) && { code: input.code }),
        };
        this.capsules.push(capsule);
        if (this.capsules.length > MAX_CAUSAL_CAPSULES)
            this.capsules.splice(0, this.capsules.length - MAX_CAUSAL_CAPSULES);
        return structuredClone(capsule);
    }

    snapshot(traceId?: string): CausalCapsule[] {
        return this.capsules
            .filter((capsule) => traceId === undefined || capsule.context.traceId === traceId)
            .map((capsule) => structuredClone(capsule));
    }
}
