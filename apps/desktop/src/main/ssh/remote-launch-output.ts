import { Buffer } from 'node:buffer';

import type { ServerDesktopCredential, ServerManifest } from '@caxri/protocol';
import { serverDesktopCredentialSchema, serverManifestSchema } from '@caxri/protocol';

import { launchFailureDetail, RemoteSetupError } from './remote-setup';

export interface LaunchedRemoteServer {
    credential: ServerDesktopCredential;
    manifest: ServerManifest;
    outcome: 'adopted' | 'started';
}

function decodeBase64Json(value: string | undefined): unknown {
    const text = Buffer.from(value ?? '', 'base64').toString('utf8');
    return JSON.parse(text);
}

/**
 * Reads the launch script's result block: the Server it adopted or started, or the `RemoteSetupError` that explains why
 * there is none. A profile another machine holds names that machine (`holder`) so the window can say which.
 */
export function parseLaunchOutput(
    result: Map<string, string> | undefined,
    stderr: string,
): LaunchedRemoteServer {
    const outcome = result?.get('outcome');
    if (outcome === 'profile-in-use') {
        // The launch script prints an empty holder when the lock names no host.
        const reported = result?.get('holder');
        const holder = reported === '' ? undefined : reported;
        throw new RemoteSetupError('profileInUse', `In use by ${holder ?? 'another host'}`, holder);
    }
    if (outcome !== 'adopted' && outcome !== 'started')
        throw new RemoteSetupError(
            'launchFailed',
            launchFailureDetail(stderr) ||
                `The remote Server did not start (${outcome ?? 'no result'})`,
        );
    let manifest: ServerManifest;
    let credential: ServerDesktopCredential;
    try {
        manifest = serverManifestSchema.parse(decodeBase64Json(result?.get('manifest')));
        credential = serverDesktopCredentialSchema.parse(
            decodeBase64Json(result?.get('credential')),
        );
    } catch {
        throw new RemoteSetupError('launchFailed', 'The remote Server discovery files are invalid');
    }
    if (
        credential.profileId !== manifest.profileId ||
        credential.processIdentity !== manifest.processIdentity
    )
        throw new RemoteSetupError('launchFailed', 'The remote Server discovery files disagree');
    return { credential, manifest, outcome };
}
