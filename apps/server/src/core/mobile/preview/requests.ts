import { realpath } from 'node:fs/promises';
import process from 'node:process';

import type { MethodResult, Principal, ServerRequest } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { ServerDomainService } from '../../domain-service';
import type { MobileDeviceRegistry } from '../device-registry';
import { isMobileGatewayMethodAllowedForRole } from '../role-methods';
import type { ListeningProcesses } from './listening-ports';
import { readListeningProcesses } from './listening-ports';
import { MobilePreviewProxies } from './proxy';
import { previewTargetsForRoots } from './targets';

const resolvedRoot = async (root: string): Promise<string> => {
    try {
        return await realpath(root);
    } catch {
        return root;
    }
};

type PreviewRequest = Extract<
    ServerRequest,
    { method: 'mobile.preview.list' | 'mobile.preview.open' }
>;

/**
 * Lists a Session's local web servers and opens a phone preview of one. The proxies live as long as mobile access: the
 * access controller clears them when the gateway is disabled or closed.
 */
export const createMobilePreviewRequests = (options: {
    logger?: Pick<StructuredLogger, 'write'>;
    random: (bytes: number) => Uint8Array;
    readListening?: () => Promise<ListeningProcesses>;
    registry: Pick<MobileDeviceRegistry, 'currentPrincipal'>;
}) => {
    const readListening = options.readListening ?? readListeningProcesses;
    const proxies = new MobilePreviewProxies({
        authorize: ({ deviceId, generation }) => {
            try {
                const principal = options.registry.currentPrincipal(deviceId, generation);
                return (
                    principal.kind === 'paired-device' &&
                    isMobileGatewayMethodAllowedForRole(principal.role, 'mobile.preview.open')
                );
            } catch {
                return false;
            }
        },
        ...(options.logger && { logger: options.logger }),
        random: options.random,
    });
    const targets = async (
        domainService: ServerDomainService,
        principal: Extract<Principal, { kind: 'paired-device' }>,
        sessionId: string,
    ) => {
        const { roots } = await domainService.request('mobile.preview.rootsInternal', {
            principal,
            sessionId,
        });
        // `lsof` reports each process's resolved working directory, while a Session root may be stored through a
        // symlink (macOS `/tmp` and `/var` live under `/private`), so both spellings of every root count.
        const resolved = await Promise.all(roots.map((root) => resolvedRoot(root)));
        let listening: ListeningProcesses;
        try {
            listening = await readListening();
        } catch {
            throw new CaxriError('UNAVAILABLE', 'Listening ports could not be read');
        }
        return previewTargetsForRoots(
            listening,
            [...new Set([...roots, ...resolved])],
            new Set([process.pid]),
        );
    };
    return {
        clear: () => proxies.clear(),
        invoke: async (
            request: PreviewRequest,
            principal: Extract<Principal, { kind: 'paired-device' }>,
            domainService: ServerDomainService,
            connectionAddress: () => string,
            reauthorize: () => void,
        ): Promise<MethodResult<PreviewRequest['method']>> => {
            const found = await targets(domainService, principal, request.params.sessionId);
            reauthorize();
            if (request.method === 'mobile.preview.list')
                return { targets: found.map(({ port, processName }) => ({ port, processName })) };
            const target = found.find((item) => item.port === request.params.port);
            if (!target)
                throw new CaxriError('NOT_FOUND', 'Nothing in this Session listens on that port');
            const { deviceId, generation } = principal;
            return {
                url: await proxies.open({ deviceId, generation }, connectionAddress(), target),
            };
        },
    };
};
