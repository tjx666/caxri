import { z } from 'zod';

/**
 * Main-owned boot configuration (`<userData>/config/argv.jsonc`), modeled after VS Code's `argv.json`: values consumed
 * before `app.whenReady()` to gate Chromium browser-process switches, which is earlier than the Runtime-owned settings
 * pipeline can deliver. Every field only takes effect on the next launch.
 */
export const argvConfigSchema = z.object({
    /**
     * Exposes CDP on `127.0.0.1:9223` in packaged builds; default-on during internal testing. Unpackaged launches
     * ignore this and always expose CDP (repository agent contract).
     */
    remoteDebugging: z.boolean(),
});

export type ArgvConfig = z.infer<typeof argvConfigSchema>;

export const argvConfigChangesSchema = argvConfigSchema.partial();

export type ArgvConfigChanges = z.infer<typeof argvConfigChangesSchema>;
