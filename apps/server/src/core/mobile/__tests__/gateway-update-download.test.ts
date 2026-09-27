import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CommandAdapter, MobileUpdatePrepareResult } from '@caxri/protocol';
import {
    CAXRI_PROTOCOL_VERSION,
    MOBILE_UPDATE_APK_FILE,
    MOBILE_UPDATE_MANIFEST_FILE,
    mobileUpdatePrepareResultSchema,
} from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MobileDeviceRecord } from '../device-registry';
import { MobileDeviceRegistry } from '../device-registry';
import { MobileGateway } from '../gateway';
import { MOBILE_UPDATE_DOWNLOAD_TTL_MS } from '../gateway/update-downloads';
import { readMobileUpdateSource } from '../update-bundle';
import { connectDevice } from './gateway-client.fixture';

const temporaryDirectories: string[] = [];
const APK_BYTES = new TextEncoder().encode('fake-apk-bytes');

afterEach(async () => {
    const paths = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
});

const temporaryDirectory = async (): Promise<string> => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-mobile-update-'));
    temporaryDirectories.push(directory);
    return directory;
};

const writeBundle = async (directory: string, sizeBytes = APK_BYTES.length): Promise<void> => {
    await writeFile(join(directory, MOBILE_UPDATE_APK_FILE), APK_BYTES);
    await writeFile(
        join(directory, MOBILE_UPDATE_MANIFEST_FILE),
        JSON.stringify({
            version: '0.0.75',
            versionCode: 75,
            sizeBytes,
            md5: 'a'.repeat(32),
        }),
    );
};

const openGateway = async (now: () => number) => {
    const directory = await temporaryDirectory();
    let byte = 1;
    const registry = await MobileDeviceRegistry.open({
        directory,
        path: join(directory, 'mobile-devices.json'),
        now: () => 1_788_106_000_000 + byte,
        random: (bytes) => new Uint8Array(bytes).fill(byte++),
    });
    const record: MobileDeviceRecord = registry.preparePair({
        displayName: 'Test phone',
        platform: 'android',
        projectIds: ['project-1'],
    });
    await registry.commitPair(record);
    await writeBundle(directory);
    const source = (await readMobileUpdateSource(directory))!;
    const holder: { gateway?: MobileGateway } = {};
    const invoke = vi.fn<CommandAdapter['invoke']>((_request, context) => ({
        bundle: source.bundle,
        ...holder.gateway!.prepareUpdateDownload(context, source),
    }));
    const gateway = new MobileGateway({
        adapters: { server: { invoke } },
        authorizePairedDeviceMethod: () => {},
        authorizeSubscription: () => Promise.resolve(),
        matchesSubscriptionEvent: () => Promise.resolve(true),
        bootId: 'b'.repeat(32),
        now,
        protocolIdentity: { serverId: 'a'.repeat(32), stateEpoch: 'c'.repeat(32) },
        registry,
        selectAddress: () => '127.0.0.1',
    });
    holder.gateway = gateway;
    const client = await connectDevice(gateway, record);
    const prepare = async (id: string): Promise<MobileUpdatePrepareResult> => {
        const reply = (await client.request({
            protocolVersion: CAXRI_PROTOCOL_VERSION,
            id,
            method: 'mobile.update.prepare',
            params: {},
        })) as { ok: boolean; result: unknown };
        expect(reply.ok).toBe(true);
        return mobileUpdatePrepareResultSchema.parse(reply.result);
    };
    return { client, gateway, prepare, record, source };
};

describe('mobile update bundle', () => {
    it('treats a directory without a manifest as no update and rejects a size mismatch', async () => {
        const directory = await temporaryDirectory();
        await expect(readMobileUpdateSource(directory)).resolves.toBeUndefined();
        await expect(readMobileUpdateSource(undefined)).resolves.toBeUndefined();
        await writeBundle(directory, APK_BYTES.length + 1);
        await expect(readMobileUpdateSource(directory)).rejects.toMatchObject({ code: 'IO' });
    });
});

describe('MobileGateway update downloads', () => {
    it('serves the APK only through a live token issued over the sealed channel', async () => {
        let now = 1_788_106_100_000;
        const { client, gateway, prepare, record } = await openGateway(() => now);
        try {
            const prepared = await prepare('prepare-1');
            expect(prepared.url).toMatch(
                /^http:\/\/127\.0\.0\.1:\d+\/mobile\/update\/[0-9a-f]{64}$/u,
            );

            const response = await fetch(prepared.url);
            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toBe(
                'application/vnd.android.package-archive',
            );
            expect(new Uint8Array(await response.arrayBuffer())).toEqual(APK_BYTES);

            const unknown = `${prepared.url.slice(0, -64)}${'0'.repeat(64)}`;
            expect((await fetch(unknown)).status).toBe(404);

            const replaced = await prepare('prepare-2');
            expect((await fetch(prepared.url)).status).toBe(404);

            now += MOBILE_UPDATE_DOWNLOAD_TTL_MS;
            expect((await fetch(replaced.url)).status).toBe(404);

            const afterRevoke = await prepare('prepare-3');
            await gateway.revoke(record.deviceId, record.generation);
            expect((await fetch(afterRevoke.url)).status).toBe(404);
        } finally {
            client.socket.close();
            await gateway.close();
        }
    });
});
