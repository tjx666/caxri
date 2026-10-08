import { z } from 'zod';

import { commandPolicy } from '../transport/method-spec.js';

/**
 * Main-owned boot configuration (`<userData>/config/argv.jsonc`), modeled after VS Code's `argv.json`: values consumed
 * before `app.whenReady()` to gate Chromium browser-process switches, which is earlier than the Runtime-owned settings
 * pipeline can deliver. Every field only takes effect on the next launch.
 */
export const argvConfigSchema = z.object({
    /**
     * Enables Chromium hardware acceleration. Main consumes this before `app.whenReady()`; false is GPU Safe Mode.
     */
    hardwareAcceleration: z.boolean(),
    /**
     * Exposes CDP on `127.0.0.1:9224` in packaged builds; default-on during internal testing. Unpackaged launches
     * ignore this and always expose CDP on `127.0.0.1:9223` (repository agent contract); `CAXRI_DEV_CDP_PORT` overrides
     * either port.
     */
    remoteDebugging: z.boolean(),
});

export type ArgvConfig = z.infer<typeof argvConfigSchema>;

export const argvConfigChangesSchema = argvConfigSchema.partial();

export type ArgvConfigChanges = z.infer<typeof argvConfigChangesSchema>;

/**
 * What the running instance actually exposes right now, unlike {@link argvConfigSchema}'s `remoteDebugging`, which is
 * only the preference the next launch will read. The two diverge for the whole lifetime of a window whose switch was
 * just flipped, and an indicator driven by the preference would claim the port had closed while it was still accepting
 * connections (DESIGN.md principle 9). An unpackaged launch always listens regardless of the stored preference.
 */
export const remoteDebuggingStateSchema = z.discriminatedUnion('transport', [
    z.object({ transport: z.literal('disabled') }),
    z.object({ transport: z.literal('pipe') }),
    z.object({
        /**
         * The loopback port Chromium is listening on. Absent only when the launch asked for an ephemeral port, which
         * Chromium picks after startup and never reports back.
         */
        port: z.string().min(1).max(16).optional(),
        transport: z.literal('port'),
    }),
]);

export type RemoteDebuggingState = z.infer<typeof remoteDebuggingStateSchema>;

const desktopRead = commandPolicy('desktop', 'read');
const desktopWrite = commandPolicy('desktop', 'write');
const noParameters = z.object({}).default({});

/**
 * Main-owned methods that read and write this boot configuration.
 */
export const argvDesktopMethods = {
    'argv.get': {
        ...desktopRead,
        params: noParameters,
        /**
         * `value` is the stored preference; `remoteDebugging` is what this instance is actually doing about it right
         * now. A live disclosure must read the second one: see `remoteDebuggingStateSchema`.
         */
        result: z.object({ remoteDebugging: remoteDebuggingStateSchema, value: argvConfigSchema }),
    },
    'argv.update': {
        ...desktopWrite,
        params: z.object({ changes: argvConfigChangesSchema }),
        result: z.object({ value: argvConfigSchema }),
    },
} as const;
