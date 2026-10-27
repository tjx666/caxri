import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { CaxriError } from '@caxri/protocol';

import { DelegationAccessRegistry } from './delegation-access-registry';
import type { ServerDomainService } from './domain-service';
import { openMobileAccessController } from './mobile';
import type { MobileAccessController } from './mobile/access-controller-contract';

type MobileAccessOptions = Omit<Parameters<typeof openMobileAccessController>[0], 'store'>;

/**
 * Builds before the single-baseline schema kept these credentials as private JSON files in the profile directory. Their
 * tables start empty after that rebuild, so the files are removed rather than left behind as stale secrets.
 */
const LEGACY_CREDENTIAL_FILES = ['mobile-devices.json', 'delegation-clients.json'];

/**
 * Holds Server Core's paired-phone and delegation-client authority. Both registries live on the Server database, which
 * opens with the domain service, so they open after `domainService.start()`. Until then no listener accepts a
 * connection that could reach them, and the hooks the domain calls answer as if no phone were connected.
 */
export function createServerCredentialAccess() {
    let mobile: MobileAccessController | undefined;
    let delegation: DelegationAccessRegistry | undefined;
    const unavailable = () => new CaxriError('UNAVAILABLE', 'Server credentials are not open yet');
    return {
        async open(
            domainService: ServerDomainService,
            directory: string,
            options: MobileAccessOptions,
        ): Promise<void> {
            const stores = await domainService.credentialStores();
            delegation = DelegationAccessRegistry.open(stores.delegationClients);
            mobile = openMobileAccessController({ ...options, store: stores.mobileDevices });
            await Promise.all(
                LEGACY_CREDENTIAL_FILES.map((name) => rm(join(directory, name), { force: true })),
            );
        },
        mobile(): MobileAccessController {
            if (!mobile) throw unavailable();
            return mobile;
        },
        delegation(): DelegationAccessRegistry {
            if (!delegation) throw unavailable();
            return delegation;
        },
        hasAttentionRecipient: (projectId: string): boolean =>
            mobile?.hasAttentionRecipient(projectId) ?? false,
        publish: (event: Parameters<MobileAccessController['publish']>[0]): void =>
            mobile?.publish(event),
        close: async (): Promise<void> => {
            await mobile?.close();
        },
    };
}
