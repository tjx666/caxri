import { z } from 'zod';

import { pathSchema } from '../domain/domain.js';

export const HOST_DESKTOP_LAUNCH_ENVIRONMENT_KEY = 'CAXRI_DESKTOP_LAUNCH';

/**
Fixed executable plus structured argv used by a profile Host to start its own Desktop app.
 */
export const hostDesktopLaunchSchema = z.object({
    executable: pathSchema,
    args: z.array(z.string().max(16_384)).max(32),
    cwd: pathSchema,
});

export type HostDesktopLaunch = z.infer<typeof hostDesktopLaunchSchema>;
