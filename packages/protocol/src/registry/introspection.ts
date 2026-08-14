import { z } from 'zod';

import {
    methods,
    type CaxriMethod,
    type CommandEffect,
    type CommandIdempotency,
    type CommandOwner,
} from './methods.js';
import type { Capability } from '../transport/principal.js';

export interface CaxriMethodDescription {
    capabilities: readonly Capability[];
    effect: CommandEffect;
    idempotency: CommandIdempotency;
    method: CaxriMethod;
    owner: CommandOwner;
    paramsSchema: Record<string, unknown>;
    resultSchema: Record<string, unknown>;
}

/** Serializes public registry metadata for offline CLI and future remote capability browsers. */
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
