import type { ServerDesktopCredential, ServerManifest } from '@caxri/protocol';

import { ServerClient } from './client.js';
import type { ServerClientCredential } from './client-support.js';
import { DEFAULT_TIMEOUT_MS } from './client-support.js';
import { discoverDesktopCredential, discoverServerManifest } from './discovery.js';

export async function connectToServer(
    userDataPath: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    credential?: Extract<
        ServerClientCredential,
        { kind: 'operator' | 'agent' | 'delegation-client' }
    >,
): Promise<ServerClient> {
    return ServerClient.connect(
        await discoverServerManifest(userDataPath),
        timeoutMs,
        credential ?? { kind: 'operator' },
    );
}

export async function connectDesktopToServer(
    userDataPath: string,
    desktopId: string,
    handleCommand: Extract<ServerClientCredential, { kind: 'desktop' }>['handleCommand'],
    timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ServerClient> {
    const manifest = await discoverServerManifest(userDataPath);
    const credential = await discoverDesktopCredential(userDataPath, manifest);
    return connectDesktopWithCredential(manifest, credential, desktopId, handleCommand, timeoutMs);
}

/**
 * Connects as Desktop with an already discovered manifest and credential. An SSH Host's Server writes its discovery
 * files on the remote machine, so Desktop Main reads them over SSH and rewrites the endpoint to its local forward
 * instead of reading a local profile.
 */
export async function connectDesktopWithCredential(
    manifest: ServerManifest,
    credential: ServerDesktopCredential,
    desktopId: string,
    handleCommand: Extract<ServerClientCredential, { kind: 'desktop' }>['handleCommand'],
    timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ServerClient> {
    return ServerClient.connect(manifest, timeoutMs, {
        kind: 'desktop',
        desktopId,
        credential,
        handleCommand,
    });
}
