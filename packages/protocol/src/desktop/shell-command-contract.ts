import { z } from 'zod';

import { commandPolicy } from '../transport/method-spec.js';

const desktopWrite = commandPolicy('desktop', 'write');
const noParameters = z.object({}).default({});

/**
 * Closed outcome of installing or removing the `caxri` shell command link. `canceled` means the user dismissed the
 * explanation dialog or the macOS administrator prompt; nothing changed and nothing failed.
 */
export const shellCommandStatuses = [
    'installed',
    'alreadyInstalled',
    'uninstalled',
    'notInstalled',
    'canceled',
] as const;

export const shellCommandResultSchema = z.object({
    status: z.enum(shellCommandStatuses),
    /**
     * Absolute path of the link on `PATH`, such as `/usr/local/bin/caxri`.
     */
    linkPath: z.string().min(1),
});

export type ShellCommandResult = z.infer<typeof shellCommandResultSchema>;

export const shellCommandDesktopMethods = {
    'shellCommand.install': {
        ...desktopWrite,
        params: noParameters,
        result: shellCommandResultSchema,
    },
    'shellCommand.uninstall': {
        ...desktopWrite,
        params: noParameters,
        result: shellCommandResultSchema,
    },
} as const;
