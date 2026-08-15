import { z } from 'zod';

import type { CommandEffect, CommandIdempotency, CommandOwner } from '../transport/method-spec.js';
import type { Capability } from '../transport/principal.js';
import type { CaxriMethod } from './methods.js';
import { methods } from './methods.js';

export interface CaxriMethodDescription {
    capabilities: readonly Capability[];
    effect: CommandEffect;
    idempotency: CommandIdempotency;
    method: CaxriMethod;
    owner: CommandOwner;
    paramsSchema: Record<string, unknown>;
    resultSchema: Record<string, unknown>;
}

/**
Serializes public registry metadata for offline CLI and future remote capability browsers.
 */
export function describeCaxriMethod(method: CaxriMethod): CaxriMethodDescription {
    const spec = methods[method];
    return {
        capabilities: spec.requiredCapabilities,
        effect: spec.effect,
        idempotency: spec.idempotency,
        method,
        owner: spec.owner,
        paramsSchema: z.toJSONSchema(spec.params),
        resultSchema: z.toJSONSchema(spec.result),
    };
}
