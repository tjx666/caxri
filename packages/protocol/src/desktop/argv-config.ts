import { z } from 'zod';

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
