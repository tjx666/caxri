import { z } from 'zod';

import { commandPolicy } from '../transport/method-spec.js';

/**
 * The Homebrew command that installs the notification helper (`alerter`). Main owns the helper, but the Settings row
 * shows and copies this exact text, so the one string lives with the contract instead of in both processes.
 */
export const NOTIFICATION_HELPER_INSTALL_COMMAND = 'brew install vjeantet/tap/alerter';

/**
 * How Desktop Main delivers system notifications right now.
 *
 * - `helper`: the notification helper (`alerter`) delivers them and a click focuses the Session.
 * - `basic`: an unsigned build without the helper falls back to plain macOS banners; a click cannot focus a Session.
 * - `native`: a signed build uses the operating system's own notification API.
 * - `unavailable`: an unsigned build without the helper, and the basic fallback just failed, so banners are not shown.
 */
export const notificationDeliverySchema = z.enum(['helper', 'basic', 'native', 'unavailable']);
export type NotificationDelivery = z.infer<typeof notificationDeliverySchema>;

export const notificationHelperStatusSchema = z.object({
    delivery: notificationDeliverySchema,
});
export type NotificationHelperStatus = z.infer<typeof notificationHelperStatusSchema>;

const desktopRead = commandPolicy('desktop', 'read');
const desktopWrite = commandPolicy('desktop', 'write');

/**
 * Main-owned methods behind Settings > Notifications > System notifications.
 */
export const notificationHelperDesktopMethods = {
    'notifications.helperStatus': {
        ...desktopRead,
        /**
         * `recheck` forgets the cached helper lookup first, so a helper installed since launch is found without a
         * restart. Without it the answer may be up to a minute old.
         */
        params: z.object({ recheck: z.boolean().optional() }).default({}),
        result: notificationHelperStatusSchema,
    },
    /**
     * Opens System Settings at its Notifications pane. Main owns the fixed `x-apple.systempreferences` URL because the
     * generic `external.open` method only opens web links.
     */
    'notifications.openSystemSettings': {
        ...desktopWrite,
        params: z.object({}).default({}),
        result: z.null(),
    },
    'notifications.sendTest': {
        ...desktopWrite,
        /**
         * The Renderer supplies the banner words so they follow the interface language; they are generic copy and never
         * Session content.
         */
        params: z.object({ body: z.string().max(200), title: z.string().min(1).max(100) }),
        /**
         * `sent` means the banner was handed to the delivery backend, not that macOS displayed it: Focus modes and the
         * per-app notification switch can still hide it.
         */
        result: z.object({ delivery: notificationDeliverySchema, sent: z.boolean() }),
    },
} as const;
