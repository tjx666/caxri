import { Buffer } from 'node:buffer';
import { randomBytes, timingSafeEqual } from 'node:crypto';

import { PAIRING_SECRET_BYTES } from '@caxri/mobile-transport';
import type { Principal } from '@caxri/protocol';
import {
    CaxriError,
    MOBILE_MAX_PROJECT_GRANTS,
    mobileDeviceIdSchema,
    mobileDeviceRoleSchema,
    mobileProjectIdsSchema,
} from '@caxri/protocol';
import { notifyListeners } from '@caxri/utils';
import { z } from 'zod';

import type { MobileDeviceStore } from '../../domains/db';

const credentialSchema = z
    .string()
    .regex(new RegExp(`^[0-9a-f]{${PAIRING_SECRET_BYTES * 2}}$`, 'u'));
const mobileDeviceRecordSchema = z.strictObject({
    deviceId: mobileDeviceIdSchema,
    displayName: z.string().trim().min(1).max(100),
    platform: z.enum(['android', 'ios']),
    credential: credentialSchema,
    generation: z.number().int().positive(),
    role: mobileDeviceRoleSchema,
    projectIds: mobileProjectIdsSchema,
    createdAt: z.number().int().positive(),
    lastConnectedAt: z.number().int().positive().optional(),
    revokedAt: z.number().int().positive().optional(),
});
const mobileDeviceRecordsSchema = z.array(mobileDeviceRecordSchema).max(128);

export type MobileDeviceRecord = z.infer<typeof mobileDeviceRecordSchema>;

/**
 * Profile-wide gateway preferences stored beside the devices, outside any one device record.
 */
interface MobileGatewayPreferences {
    isAccessEnabled: boolean;
    preferredPort: number | undefined;
    relayHostKey?: string;
}
export type MobileDeviceSummary = Omit<MobileDeviceRecord, 'credential'>;

export interface MobileDeviceRegistryOptions {
    now?: () => number;
    random?: (bytes: number) => Uint8Array;
    store: MobileDeviceStore;
}

function publicRecord(record: MobileDeviceRecord): MobileDeviceSummary {
    return {
        deviceId: record.deviceId,
        displayName: record.displayName,
        platform: record.platform,
        generation: record.generation,
        role: record.role,
        projectIds: [...record.projectIds],
        createdAt: record.createdAt,
        ...(record.lastConnectedAt && { lastConnectedAt: record.lastConnectedAt }),
        ...(record.revokedAt && { revokedAt: record.revokedAt }),
    };
}

function writeStore(
    store: MobileDeviceStore,
    devices: Iterable<MobileDeviceRecord>,
    preferences: MobileGatewayPreferences,
): void {
    const records = [...devices];
    if (records.length > 128) throw new CaxriError('CAPACITY', 'Mobile device registry is full');
    store.write(mobileDeviceRecordsSchema.parse(records), {
        ...(preferences.preferredPort && { preferredPort: preferences.preferredPort }),
        ...(preferences.isAccessEnabled && { accessEnabled: true }),
        ...(preferences.relayHostKey && { relayHostKey: preferences.relayHostKey }),
    });
}

/**
 * Owns paired-device credentials and grants for one Server profile. Mutations apply to a copy, persist it to
 * `mobile_devices` in one transaction, and only then replace the in-memory set, so a failed write changes nothing.
 */
export class MobileDeviceRegistry {
    static open(options: MobileDeviceRegistryOptions): MobileDeviceRegistry {
        const { devices, preferences } = options.store.load();
        const parsed = mobileDeviceRecordsSchema.safeParse(devices);
        if (!parsed.success)
            throw new CaxriError('VALIDATION', 'Mobile device registry is malformed');
        return new MobileDeviceRegistry(options, parsed.data, {
            isAccessEnabled: preferences.accessEnabled === true,
            preferredPort: preferences.preferredPort,
            ...(preferences.relayHostKey && { relayHostKey: preferences.relayHostKey }),
        });
    }

    readonly #now: () => number;
    readonly #options: MobileDeviceRegistryOptions;
    readonly #random: (bytes: number) => Uint8Array;
    #preferences: MobileGatewayPreferences;
    #records: Map<string, MobileDeviceRecord>;
    readonly #deviceListeners = new Set<() => void>();
    #writeTail = Promise.resolve();

    private constructor(
        options: MobileDeviceRegistryOptions,
        records: MobileDeviceRecord[],
        preferences: MobileGatewayPreferences,
    ) {
        this.#options = options;
        this.#now = options.now ?? Date.now;
        this.#random = options.random ?? randomBytes;
        this.#preferences = preferences;
        this.#records = new Map(records.map((record) => [record.deviceId, record]));
        if (this.#records.size !== records.length)
            throw new CaxriError('VALIDATION', 'Mobile device registry contains duplicate devices');
    }

    #principal(record: MobileDeviceRecord): Principal {
        return {
            kind: 'paired-device',
            id: `paired-device:${record.deviceId}`,
            deviceId: record.deviceId,
            generation: record.generation,
            role: record.role,
            projectIds: [...record.projectIds],
        };
    }

    async #mutate<T>(change: (records: Map<string, MobileDeviceRecord>) => T): Promise<T> {
        const previousWrite = this.#writeTail;
        const operation = (async (): Promise<T> => {
            await previousWrite;
            const records = new Map(this.#records);
            const result = change(records);
            writeStore(this.#options.store, records.values(), this.#preferences);
            this.#records = records;
            notifyListeners(this.#deviceListeners, undefined);
            return result;
        })();
        this.#writeTail = (async (): Promise<void> => {
            try {
                await operation;
            } catch {
                // A failed write releases the write queue for the next mutation.
            }
        })();
        return operation;
    }

    async #rememberPreferences(next: MobileGatewayPreferences): Promise<void> {
        if (
            this.#preferences.preferredPort === next.preferredPort &&
            this.#preferences.isAccessEnabled === next.isAccessEnabled &&
            this.#preferences.relayHostKey === next.relayHostKey
        )
            return;
        const previousWrite = this.#writeTail;
        const operation = (async (): Promise<void> => {
            await previousWrite;
            writeStore(this.#options.store, this.#records.values(), next);
            this.#preferences = next;
        })();
        this.#writeTail = (async () => {
            try {
                await operation;
            } catch {
                // The returned operation owns the failure; the serialized tail only stays usable.
            }
        })();
        return operation;
    }

    list(): MobileDeviceSummary[] {
        return this.#records
            .values()
            .toArray()
            .toSorted((left, right) => left.createdAt - right.createdAt)
            .map(publicRecord);
    }

    preferredPort(): number | undefined {
        return this.#preferences.preferredPort;
    }

    async rememberPort(port: number): Promise<void> {
        const preferredPort = z.number().int().min(1).max(65_535).parse(port);
        await this.#rememberPreferences({ ...this.#preferences, preferredPort });
    }

    isAccessEnabled(): boolean {
        return this.#preferences.isAccessEnabled;
    }

    async rememberAccessEnabled(isAccessEnabled: boolean): Promise<void> {
        await this.#rememberPreferences({ ...this.#preferences, isAccessEnabled });
    }

    /**
     * The Relay host secret key, created and persisted on first use. Concurrent first calls share the serialized write
     * queue, so they converge on whichever key reached the store first.
     */
    async relayHostKey(): Promise<string> {
        if (this.#preferences.relayHostKey) return this.#preferences.relayHostKey;
        const candidate = Buffer.from(this.#random(32)).toString('hex');
        await this.#writeTail;
        if (this.#preferences.relayHostKey) return this.#preferences.relayHostKey;
        await this.#rememberPreferences({ ...this.#preferences, relayHostKey: candidate });
        return this.#preferences.relayHostKey ?? candidate;
    }

    /**
     * Credentials of every device that may currently connect; the Relay grants are one-way derivations of these.
     */
    activeCredentials(): string[] {
        return this.#records
            .values()
            .filter((record) => record.revokedAt === undefined)
            .map((record) => record.credential)
            .toArray();
    }

    /**
     * Notifies after every committed device mutation (pairing, revocation, grant, connection stamp). Listeners
     * recompute derived state such as Relay grants; they receive no record data.
     */
    onDevicesChanged(listener: () => void): () => void {
        this.#deviceListeners.add(listener);
        return () => this.#deviceListeners.delete(listener);
    }

    async pair(input: {
        displayName: string;
        platform: 'android' | 'ios';
        projectIds: string[];
    }): Promise<{ credential: string; device: MobileDeviceSummary }> {
        const record = this.preparePair(input);
        const device = await this.commitPair(record);
        return { credential: record.credential, device };
    }

    preparePair(input: {
        displayName: string;
        platform: 'android' | 'ios';
        projectIds: string[];
    }): MobileDeviceRecord {
        if (
            this.#records
                .values()
                .filter((record) => record.revokedAt === undefined)
                .toArray().length >= 128
        )
            throw new CaxriError('CAPACITY', 'Mobile device registry is full');
        return mobileDeviceRecordSchema.parse({
            ...input,
            deviceId: `device_${Buffer.from(this.#random(16)).toString('hex')}`,
            credential: Buffer.from(this.#random(PAIRING_SECRET_BYTES)).toString('hex'),
            generation: 1,
            role: 'control',
            createdAt: this.#now(),
        });
    }

    async commitPair(candidate: MobileDeviceRecord): Promise<MobileDeviceSummary> {
        const record = mobileDeviceRecordSchema.parse(candidate);
        return this.#mutate((records) => {
            for (const [deviceId, current] of records)
                if (current.revokedAt !== undefined) records.delete(deviceId);
            if (records.size >= 128)
                throw new CaxriError('CAPACITY', 'Mobile device registry is full');
            if (records.has(record.deviceId))
                throw new CaxriError('CONFLICT', 'Mobile device identity already exists');
            records.set(record.deviceId, record);
            return publicRecord(record);
        });
    }

    handshakeMaterial(
        deviceId: string,
        generation: number,
    ): { credential: string; principal: Principal } | undefined {
        const record = this.#records.get(deviceId);
        if (!record || record.revokedAt !== undefined || record.generation !== generation) return;
        return { credential: record.credential, principal: this.#principal(record) };
    }

    /**
     * Credential for an update-recovery proof, or the reason there is none. The reason reaches only the Server's closed
     * log outcome; the phone always receives the same rejection.
     */
    recoveryMaterial(
        deviceId: string,
        generation: number,
    ):
        | { credential: string; kind: 'paired' }
        | { kind: 'revoked' | 'stale-generation' | 'unpaired' } {
        const record = this.#records.get(deviceId);
        if (!record) return { kind: 'unpaired' };
        if (record.revokedAt !== undefined) return { kind: 'revoked' };
        if (record.generation !== generation) return { kind: 'stale-generation' };
        return { credential: record.credential, kind: 'paired' };
    }

    authenticate(input: { credential: string; deviceId: string; generation: number }): Principal {
        const record = this.#records.get(input.deviceId);
        const expected = Buffer.from(
            record?.credential ?? '00'.repeat(PAIRING_SECRET_BYTES),
            'hex',
        );
        const supplied = Buffer.from(
            credentialSchema.safeParse(input.credential).success
                ? input.credential
                : 'ff'.repeat(PAIRING_SECRET_BYTES),
            'hex',
        );
        const isCredentialValid = timingSafeEqual(expected, supplied);
        if (
            !isCredentialValid ||
            !record ||
            record.revokedAt !== undefined ||
            record.generation !== input.generation
        )
            throw new CaxriError('FORBIDDEN', 'Paired device authorization is unavailable');
        return this.#principal(record);
    }

    currentPrincipal(deviceId: string, generation: number): Principal {
        const record = this.#records.get(deviceId);
        if (!record || record.revokedAt !== undefined || record.generation !== generation)
            throw new CaxriError('FORBIDDEN', 'Paired device authorization is unavailable');
        return this.#principal(record);
    }

    async markConnected(deviceId: string, generation: number): Promise<MobileDeviceSummary> {
        return this.#mutate((records) => {
            const record = records.get(deviceId);
            if (!record || record.revokedAt !== undefined || record.generation !== generation)
                throw new CaxriError('FORBIDDEN', 'Paired device authorization is unavailable');
            const updated = mobileDeviceRecordSchema.parse({
                ...record,
                lastConnectedAt: this.#now(),
            });
            records.set(deviceId, updated);
            return publicRecord(updated);
        });
    }

    /**
     * Additive-only: an existing grant is left untouched and the credential/generation do not change, since widening a
     * device's own visible Projects is not the security-sensitive transition {@link revoke} guards against. Connections
     * holding the pre-grant principal adopt the longer `projectIds` list through `adoptCurrentPairedPrincipal`.
     */
    async grantProject(
        deviceId: string,
        expectedGeneration: number,
        projectId: string,
    ): Promise<MobileDeviceSummary> {
        return this.#mutate((records) => {
            const record = records.get(deviceId);
            if (
                !record ||
                record.revokedAt !== undefined ||
                record.generation !== expectedGeneration
            )
                throw new CaxriError('FORBIDDEN', 'Paired device authorization is unavailable');
            if (record.projectIds.includes(projectId)) return publicRecord(record);
            if (record.projectIds.length >= MOBILE_MAX_PROJECT_GRANTS)
                throw new CaxriError('CAPACITY', 'Paired device Project grants are full');
            const updated = mobileDeviceRecordSchema.parse({
                ...record,
                projectIds: [...record.projectIds, projectId],
            });
            records.set(deviceId, updated);
            return publicRecord(updated);
        });
    }

    async revoke(deviceId: string, expectedGeneration: number): Promise<MobileDeviceSummary> {
        return this.#mutate((records) => {
            const record = records.get(deviceId);
            if (!record) throw new CaxriError('NOT_FOUND', 'Paired device not found');
            if (record.revokedAt !== undefined || record.generation !== expectedGeneration)
                throw new CaxriError('CONFLICT', 'Paired device changed before it was revoked');
            const updated = mobileDeviceRecordSchema.parse({
                ...record,
                credential: Buffer.from(this.#random(PAIRING_SECRET_BYTES)).toString('hex'),
                generation: record.generation + 1,
                revokedAt: this.#now(),
            });
            records.set(deviceId, updated);
            return publicRecord(updated);
        });
    }
}
