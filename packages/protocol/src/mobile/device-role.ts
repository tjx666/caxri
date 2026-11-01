import { z } from 'zod';

export const mobileDeviceRoleSchema = z.enum(['view', 'reply', 'control']);
export type MobileDeviceRole = z.infer<typeof mobileDeviceRoleSchema>;

export const mobileDeviceIdSchema = z.string().regex(/^device_[0-9a-f]{32}$/u);
