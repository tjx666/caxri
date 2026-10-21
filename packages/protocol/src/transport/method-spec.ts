import type { z } from 'zod';

import type { Capability, Principal } from './principal.js';

export type CommandOwner = 'server' | 'desktop';
export type CommandEffect = 'read' | 'write' | 'control';
export type CommandIdempotency = 'none' | 'request';
/**
 * `durable` permits the validated reply to cross a Server boot; `memory` deliberately keeps a content-bearing or
 * boot-scoped reply in RAM; `none` is reserved for ordered stream setup, bytes, and geometry that cannot await
 * fingerprinting.
 */
export type CommandRecovery = 'none' | 'memory' | 'durable';

export interface MethodSpec {
    owner: CommandOwner;
    effect: CommandEffect;
    requiredCapabilities: readonly Capability[];
    /**
     * `owner` restricts the method to the user's own clients (Desktop and the human CLI). Capabilities alone cannot
     * express it: an Agent Endpoint grant can carry the same capability. Server Core enforces it from the spec, so a
     * new owner-only method needs no second list.
     */
    principal?: 'owner';
    idempotency: CommandIdempotency;
    params: z.ZodType;
    result: z.ZodType;
    projectResult?: (result: unknown, principal: Principal) => unknown;
}

export function commandPolicy<Owner extends CommandOwner, Effect extends CommandEffect>(
    owner: Owner,
    effect: Effect,
    requiredCapabilities: readonly Capability[] = ['desktop'],
) {
    return {
        owner,
        effect,
        requiredCapabilities,
        idempotency: effect === 'read' ? 'none' : 'request',
    } as const;
}

/**
 * A `commandPolicy` that only the owner's own clients (Desktop, human CLI) may call; see `MethodSpec.principal`.
 */
export function ownerOnlyCommandPolicy<Owner extends CommandOwner, Effect extends CommandEffect>(
    owner: Owner,
    effect: Effect,
    requiredCapabilities: readonly Capability[] = ['desktop'],
) {
    return { ...commandPolicy(owner, effect, requiredCapabilities), principal: 'owner' } as const;
}
