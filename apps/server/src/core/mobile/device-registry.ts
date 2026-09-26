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
import { z } from 'zod';

import { fileSystemCode, readPrivateJsonFile, replacePrivateJsonFile } from '../private-json-store';

const MAXIMUM_REGISTRY_BYTES = 128 * 1024;
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

const mobileDeviceStoreSchema = z.strictObject({
    version: z.literal(2),
    preferredPort: z.number().int().min(1).max(65_535).optional(),
    devices: z.array(mobileDeviceRecordSchema).max(128),
});
const legacyMobileDeviceStoreSchema = z.strictObject({
    version: z.literal(1),
    preferredPort: z.number().int().min(1).max(65_535).optional(),
    devices: z.array(mobileDeviceRecordSchema.omit({ role: true })).max(128),
});
const readableMobileDeviceStoreSchema = z.discriminatedUnion('version', [
    legacyMobileDeviceStoreSchema,
    mobileDeviceStoreSchema,
]);

export type MobileDeviceRecord = z.infer<typeof mobileDeviceRecordSchema>;
export type MobileDeviceSummary = Omit<MobileDeviceRecord, 'credential'>;

export interface MobileDeviceRegistryOptions {
    directory: string;
    now?: () => number;
    path: string;
    random?: (bytes: number) => Uint8Array;
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

async function readPrivateStore(
    path: string,
): Promise<z.infer<typeof readableMobileDeviceStoreSchema>> {
    const source = await readPrivateJsonFile({
        path,
        maxBytes: MAXIMUM_REGISTRY_BYTES,
        messages: {
            malformed: 'Mobile device registry is malformed',
            notPrivate: 'Mobile device registry is not private',
            oversized: 'Mobile device registry is oversized',
            wrongOwner: 'Mobile device registry belongs to another user',
        },
    });
    try {
        return readableMobileDeviceStoreSchema.parse(source);
    } catch (error) {
        if (error instanceof CaxriError) throw error;
        throw new CaxriError('VALIDATION', 'Mobile device registry is malformed');
    }
}

async function writePrivateStore(
    directory: string,
    path: string,
    devices: Iterable<MobileDeviceRecord>,
    preferredPort: number | undefined,
    random: (bytes: number) => Uint8Array,
): Promise<void> {
    const value = mobileDeviceStoreSchema.parse({
        version: 2,
        ...(preferredPort && { preferredPort }),
        devices: [...devices],
    });
    if (Buffer.byteLength(`${JSON.stringify(value)}\n`, 'utf8') > MAXIMUM_REGISTRY_BYTES)
        throw new CaxriError('CAPACITY', 'Mobile device registry is full');
    await replacePrivateJsonFile({
        directory,
        path,
        random,
        temporaryPrefix: '.mobile-devices-',
        value,
    });
}

/**
 * Owns the only durable copy of paired-device credentials and grants for one Server profile.
 */
export class MobileDeviceRegistry {
    static async open(options: MobileDeviceRegistryOptions): Promise<MobileDeviceRegistry> {
        try {
            const store = await readPrivateStore(options.path);
            /**
             * Legacy grants have no role and cannot authenticate until the owner explicitly pairs again.
             */
            return new MobileDeviceRegistry(
                options,
                store.version === 2 ? store.devices : [],
                store.preferredPort,
                store.version === 1,
            );
        } catch (error) {
            if (fileSystemCode(error) === 'ENOENT')
                return new MobileDeviceRegistry(options, [], undefined, false);
            throw error;
        }
    }

    readonly #now: () => number;
    readonly #options: MobileDeviceRegistryOptions;
    readonly #random: (bytes: number) => Uint8Array;
    #preferredPort: number | undefined;
    #isLegacyStore: boolean;
    #records: Map<string, MobileDeviceRecord>;
    #writeTail = Promise.resolve();

    private constructor(
        options: MobileDeviceRegistryOptions,
        records: MobileDeviceRecord[],
        preferredPort: number | undefined,
        isLegacyStore: boolean,
    ) {
        this.#options = options;
        this.#now = options.now ?? Date.now;
        this.#random = options.random ?? randomBytes;
        this.#preferredPort = preferredPort;
        this.#isLegacyStore = isLegacyStore;
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
            await writePrivateStore(
                this.#options.directory,
                this.#options.path,
                records.values(),
                this.#preferredPort,
                this.#random,
            );
            this.#records = records;
            this.#isLegacyStore = false;
            return result;
        })();
        this.#writeTail = (async (): Promise<void> => {
            try {
                await operation;
            } catch {
                // A failed atomic replacement releases the write queue for the next mutation.
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
        return this.#preferredPort;
    }

    async rememberPort(port: number): Promise<void> {
        const nextPort = z.number().int().min(1).max(65_535).parse(port);
        if (this.#preferredPort === nextPort) return;
        const previousWrite = this.#writeTail;
        const operation = (async (): Promise<void> => {
            await previousWrite;
            if (this.#isLegacyStore) {
                this.#preferredPort = nextPort;
                return;
            }
            await writePrivateStore(
                this.#options.directory,
                this.#options.path,
                this.#records.values(),
                nextPort,
                this.#random,
            );
            this.#preferredPort = nextPort;
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
