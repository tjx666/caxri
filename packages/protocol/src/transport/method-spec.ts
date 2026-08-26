import type { z } from 'zod';

import type { Capability, Principal } from './principal.js';

export type CommandOwner = 'server' | 'desktop';
export type CommandEffect = 'read' | 'write' | 'control';
export type CommandIdempotency = 'none' | 'request';

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
