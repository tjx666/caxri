import { z } from 'zod';

import { auxiliaryWindowStateSchema, persistedWindowStateSchema } from '../domain/domain.js';
import { identifierSchema } from '../domain/identifiers.js';
import { commandPolicy } from '../transport/method-spec.js';
import { performanceMonitorMetricsSchema } from './performance-monitor-metrics.js';

const serverRead = commandPolicy('server', 'read');
const serverWrite = commandPolicy('server', 'write');
const desktopRead = commandPolicy('desktop', 'read');
const desktopControl = commandPolicy('desktop', 'control');
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
     * Cross-restart state for Caxri Bot and Process Explorer windows.
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
 * Main-owned window methods. `window.fullScreen.get` is live state Main owns for the window that sent the request, so
 * Caxri Bot reads its own state rather than the Workbench's. A Renderer reads it once it subscribes to events instead
 * of relying on replaying the last `window.fullScreen` push: a Renderer that (re)loads after the event journal has
 * rotated recovers from a snapshot, and that snapshot carries no window state. The `*.open` methods open an optional
 * single-instance window, or raise it when it is already open; `caxriBot.open` lives with its own contract because it
 * takes a target.
 */
export const windowDesktopMethods = {
    'window.fullScreen.get': {
        ...desktopRead,
        params: noParameters,
        result: z.object({ isFullScreen: z.boolean() }),
    },
    /**
     * Tells Main which Session the sending Workbench window renders, or `null` for none. Main owns the rest of the
     * window's presence (native focus, visibility, minimize) and forwards the whole row to the Server, so a Renderer
     * cannot claim focus it does not have. Main answers for the sender only; it never accepts a window key.
     */
    'window.reportViewing': {
        ...desktopControl,
        params: z.object({ viewingSessionId: identifierSchema.nullable() }),
        result: z.null(),
    },
    /**
     * Opens a Session in a new window, the sidebar row menu's "Open in New Window". Main mints the new window's key and
     * cascades it from the sending window; a Renderer supplies neither. `opened` is false for a normal refusal (the
     * Session is the one the sender shows, or another window has it open), never an error.
     */
    'window.tearOffSession': {
        ...desktopControl,
        params: z.object({
            sessionId: identifierSchema,
        }),
        result: z.object({ opened: z.boolean() }),
    },
    'processExplorer.open': { ...desktopControl, params: noParameters, result: z.null() },
    'benchmark.open': { ...desktopControl, params: noParameters, result: z.null() },
    /**
     * Opens, raises, closes, or toggles the Performance Monitor's own window. The in-window overlay is Renderer state
     * and needs no method.
     */
    'performanceMonitor.window': {
        ...desktopControl,
        params: z.object({ action: z.enum(['open', 'close', 'toggle']) }),
        result: z.null(),
    },
    /**
     * Process and GPU readings the Performance Monitor shows beside the frame rate it measures itself. Main samples
     * through the Process Explorer's sampler, so the two never disturb each other's CPU deltas.
     */
    'performanceMonitor.metrics': {
        ...desktopRead,
        params: noParameters,
        result: performanceMonitorMetricsSchema,
    },
} as const;
