import { z } from 'zod';

import { pathSchema } from '../domain/identifiers.js';

export const SERVER_DESKTOP_LAUNCH_ENVIRONMENT_KEY = 'CAXRI_DESKTOP_LAUNCH';

/**
 * Fixed executable plus structured argv used by a profile Server to start its own Desktop app.
 */
export const serverDesktopLaunchSchema = z.object({
    executable: pathSchema,
    args: z.array(z.string().max(16_384)).max(32),
    cwd: pathSchema,
});

export type ServerDesktopLaunch = z.infer<typeof serverDesktopLaunchSchema>;
