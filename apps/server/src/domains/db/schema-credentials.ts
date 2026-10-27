import type { MobileDeviceRole } from '@caxri/protocol';
import { check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { closedValues, isOneOf } from './schema-constraints';

/**
 * Server Core's durable external identities: paired phones and delegation clients. Server Core keeps the authoritative
 * copy in memory and rewrites a whole table per mutation (each is capped at 128 rows), so these tables carry no foreign
 * keys into Projects or Sessions: a grant naming a deleted Project is fenced when the request is authorized, exactly as
 * before the credentials moved out of their private JSON files.
 */

const mobilePlatforms = closedValues<'android' | 'ios'>()(['android', 'ios']);
const mobileRoles = closedValues<MobileDeviceRole>()(['view', 'reply', 'control']);

/**
 * One row per paired phone. `credential` is the pairing secret in hex; `generation` advances on every revocation so a
 * stale principal can never act again. `project_ids_json` is the device's Project grant list.
 */
export const mobileDevices = sqliteTable(
    'mobile_devices',
    {
        deviceId: text('device_id').primaryKey(),
        displayName: text('display_name').notNull(),
        platform: text('platform').notNull(),
        credential: text('credential').notNull(),
        generation: integer('generation').notNull(),
        role: text('role').notNull(),
        projectIdsJson: text('project_ids_json').notNull(),
        createdAt: integer('created_at').notNull(),
        lastConnectedAt: integer('last_connected_at'),
        revokedAt: integer('revoked_at'),
    },
    (table) => [
        check('mobile_devices_platform', isOneOf(table.platform, mobilePlatforms)),
        check('mobile_devices_role', isOneOf(table.role, mobileRoles)),
    ],
);

/**
 * One row per delegation client the owner CLI minted. Only the SHA-256 digest of the bearer token is stored.
 * `caller_provider` stays open-ended like every other provider column (see `./schema-constraints`).
 */
export const delegationClients = sqliteTable('delegation_clients', {
    clientId: text('client_id').primaryKey(),
    generation: integer('generation').notNull(),
    projectId: text('project_id').notNull(),
    sessionId: text('session_id').notNull(),
    callerProvider: text('caller_provider').notNull(),
    tokenDigest: text('token_digest').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    revokedAt: integer('revoked_at'),
});
