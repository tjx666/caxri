import { z } from 'zod';

import { commandPolicy } from '../transport/method-spec.js';

const desktopControl = commandPolicy('desktop', 'control');

export const logsDesktopMethods = {
    /**
     * Shows this Mac's Caxri log folder in Finder. Answered by Desktop Main from its own profile, so it keeps working
     * when Server Core is down, which is exactly when a user needs the logs.
     */
    'logs.reveal': {
        ...desktopControl,
        params: z.object({}).default({}),
        result: z.null(),
    },
    /**
     * Relaunches Caxri itself. Answered by Desktop Main, so it is the recovery path when Server Core has stopped and
     * the "Caxri stopped" status chip is all the Renderer has left.
     */
    'app.relaunch': {
        ...desktopControl,
        params: z.object({}).default({}),
        result: z.null(),
    },
    /**
     * Shows the diagnostics bundle this window last exported in Finder. Takes no path on purpose: Desktop Main
     * remembers what the save dialog returned, so the Renderer cannot ask it to reveal an arbitrary location.
     */
    'diagnostics.revealExport': {
        ...desktopControl,
        params: z.object({}).default({}),
        result: z.null(),
    },
} as const;
