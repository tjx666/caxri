import type { z } from 'zod';

import type { Capability, Principal } from './principal.js';

export type CommandOwner = 'server' | 'desktop';
export type CommandEffect = 'read' | 'write' | 'control';
export type CommandIdempotency = 'none' | 'request';
/**
 * `durable` permits the validated reply to cross a Server boot; `memory` deliberately keeps a content-bearing or
 * boot-scoped reply in RAM; `none` is reserved for ordered byte/geometry streams that cannot await fingerprinting.
 */
export type CommandRecovery = 'none' | 'memory' | 'durable';

export interface MethodSpec {
    owner: CommandOwner;
    effect: CommandEffect;
    requiredCapabilities: readonly Capability[];
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
