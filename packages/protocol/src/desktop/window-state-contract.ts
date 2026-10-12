import { z } from 'zod';

import { auxiliaryWindowStateSchema, persistedWindowStateSchema } from '../domain/domain.js';
import { commandPolicy } from '../transport/method-spec.js';

const serverRead = commandPolicy('server', 'read');
const serverWrite = commandPolicy('server', 'write');
const desktopRead = commandPolicy('desktop', 'read');
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

/**
 * Live state that Main owns for the window that sent the request, so the Agent Commander reads its own state rather
 * than the Workbench's. A Renderer reads it once it subscribes to events instead of relying on replaying the last
 * `window.fullScreen` push: a Renderer that (re)loads after the event journal has rotated recovers from a snapshot, and
 * that snapshot carries no window state.
 */
export const windowChromeDesktopMethods = {
    'window.fullScreen.get': {
        ...desktopRead,
        params: noParameters,
        result: z.object({ isFullScreen: z.boolean() }),
    },
} as const;
