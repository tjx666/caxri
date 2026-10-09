import { z } from 'zod';

import { auxiliaryWindowStateSchema, persistedWindowStateSchema } from '../domain/domain.js';
import { commandPolicy } from '../transport/method-spec.js';

const serverRead = commandPolicy('server', 'read');
const serverWrite = commandPolicy('server', 'write');
const noParameters = z.object({}).default({});

/**
 * Cross-restart window geometry that Server Core persists for Desktop Main; only Main ever calls these.
 */
export const windowStateInternalMethods = {
    'app.windowState.get': {
        ...serverRead,
        params: noParameters,
        result: persistedWindowStateSchema,
    },
    'app.windowState.update': {
        ...serverWrite,
        params: persistedWindowStateSchema,
        result: persistedWindowStateSchema,
    },
    /**
     * Cross-restart state for the Agent Commander and Process Explorer windows.
     */
    'app.auxiliaryWindowState.get': {
        ...serverRead,
        params: noParameters,
        result: auxiliaryWindowStateSchema,
    },
    'app.auxiliaryWindowState.update': {
        ...serverWrite,
        params: auxiliaryWindowStateSchema,
        result: auxiliaryWindowStateSchema,
    },
} as const;
