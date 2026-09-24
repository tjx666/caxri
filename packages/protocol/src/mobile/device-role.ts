import { z } from 'zod';

export const mobileDeviceRoleSchema = z.enum(['view', 'reply', 'control']);
export type MobileDeviceRole = z.infer<typeof mobileDeviceRoleSchema>;
