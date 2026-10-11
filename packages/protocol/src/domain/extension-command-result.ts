import { z } from 'zod';

/**
 * Longest command result message the Workbench shows. A toast is one short sentence, so anything longer is cut.
 */
export const MAX_EXTENSION_COMMAND_MESSAGE_LENGTH = 200;

export const extensionCommandResultSchema = z.object({
    executed: z.literal(true),
    /**
     * Short success text the command resolved with, shown by the Workbench as a toast (`Squash-merged #123`).
     */
    message: z.string().min(1).max(MAX_EXTENSION_COMMAND_MESSAGE_LENGTH).optional(),
});

export type ExtensionCommandResult = z.infer<typeof extensionCommandResultSchema>;

/**
 * Projects whatever an extension command resolved with onto the wire result. Only `{ message: string }` carries
 * anything: the message is trimmed and capped, and every other value (including a blank message) is ignored rather than
 * failing a command that already ran.
 */
export function extensionCommandResult(value: unknown): ExtensionCommandResult {
    const message =
        typeof value === 'object' &&
        value !== null &&
        'message' in value &&
        typeof value.message === 'string'
            ? value.message.trim().slice(0, MAX_EXTENSION_COMMAND_MESSAGE_LENGTH).trim()
            : '';
    return message ? { executed: true, message } : { executed: true };
}
