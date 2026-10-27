import { CaxriError } from '@caxri/protocol';
import type Database from 'better-sqlite3';

import type { CaxriDrizzleDatabase } from '../connection';
import { delegationClients, mobileDevices } from '../schema';
import type { AppStateModel } from './app-state';

/**
 * A paired phone as Server Core's registry holds it; the registry validates every loaded row against its own schema.
 */
export interface MobileDeviceRow {
    deviceId: string;
    displayName: string;
    platform: string;
    credential: string;
    generation: number;
    role: string;
    projectIds: string[];
    createdAt: number;
    lastConnectedAt?: number;
    revokedAt?: number;
}

export interface MobileGatewayPreferenceRow {
    accessEnabled?: true;
    preferredPort?: number;
}

export interface DelegationClientRow {
    clientId: string;
    generation: number;
    projectId: string;
    sessionId: string;
    callerProvider: string;
    tokenDigest: string;
    createdAt: number;
    expiresAt: number;
    revokedAt?: number;
}

/**
 * Durable storage for `MobileDeviceRegistry`. `write` rewrites the whole device set and the gateway preferences in one
 * transaction, so a crash never leaves a half-applied pairing or revocation.
 */
export interface MobileDeviceStore {
    load(): { devices: MobileDeviceRow[]; preferences: MobileGatewayPreferenceRow };
    write(devices: readonly MobileDeviceRow[], preferences: MobileGatewayPreferenceRow): void;
}

/**
 * Durable storage for `DelegationAccessRegistry`; `write` rewrites every client in one transaction.
 */
export interface DelegationClientStore {
    load(): DelegationClientRow[];
    write(clients: readonly DelegationClientRow[]): void;
}

export interface ServerCredentialStores {
    delegationClients: DelegationClientStore;
    mobileDevices: MobileDeviceStore;
}

/**
 * Pure CRUD over `mobile_devices`, `delegation_clients`, and the `mobileGateway` app-state cell. Server Core owns the
 * authorization decisions; see `core/mobile/device-registry.ts` and `core/delegation-access-registry.ts`.
 */
export function createServerCredentialStores(
    database: CaxriDrizzleDatabase,
    connection: Database.Database,
    appState: AppStateModel,
): ServerCredentialStores {
    /**
     * Server Core closes the database before its mobile gateway and control server, so a pairing or delegation request
     * that lands during shutdown must fail as a retryable UNAVAILABLE rather than better-sqlite3's bare TypeError.
     */
    const assertOpen = () => {
        if (!connection.open) throw new CaxriError('UNAVAILABLE', 'Server database is closed');
    };
    return {
        mobileDevices: {
            load: () => ({
                devices: database
                    .select()
                    .from(mobileDevices)
                    .all()
                    .map(({ lastConnectedAt, projectIdsJson, revokedAt, ...row }) => ({
                        ...row,
                        projectIds: JSON.parse(projectIdsJson) as string[],
                        ...(lastConnectedAt !== null && { lastConnectedAt }),
                        ...(revokedAt !== null && { revokedAt }),
                    })),
                preferences: appState.get('mobileGateway') ?? {},
            }),
            write: (devices, preferences) => {
                assertOpen();
                connection.transaction(() => {
                    database.delete(mobileDevices).run();
                    if (devices.length > 0)
                        database
                            .insert(mobileDevices)
                            .values(
                                devices.map(({ projectIds, ...device }) => ({
                                    ...device,
                                    projectIdsJson: JSON.stringify(projectIds),
                                    lastConnectedAt: device.lastConnectedAt ?? null,
                                    revokedAt: device.revokedAt ?? null,
                                })),
                            )
                            .run();
                    appState.set('mobileGateway', preferences);
                })();
            },
        },
        delegationClients: {
            load: () =>
                database
                    .select()
                    .from(delegationClients)
                    .all()
                    .map(({ revokedAt, ...row }) => ({
                        ...row,
                        ...(revokedAt !== null && { revokedAt }),
                    })),
            write: (clients) => {
                assertOpen();
                connection.transaction(() => {
                    database.delete(delegationClients).run();
                    if (clients.length > 0)
                        database
                            .insert(delegationClients)
                            .values(
                                clients.map((client) => ({
                                    ...client,
                                    revokedAt: client.revokedAt ?? null,
                                })),
                            )
                            .run();
                })();
            },
        },
    };
}
