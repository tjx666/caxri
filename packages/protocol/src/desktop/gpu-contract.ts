import { z } from 'zod';

import { commandPolicy } from '../transport/method-spec.js';

const desktopControl = commandPolicy('desktop', 'control');
const noParameters = z.object({}).default({});

export const gpuDesktopMethods = {
    'gpu.restartInSafeMode': { ...desktopControl, params: noParameters, result: z.null() },
    'gpu.testInjectContextLoss': {
        ...desktopControl,
        params: noParameters,
        result: z.object({ correlationId: z.uuid() }),
    },
} as const;
