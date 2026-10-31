import type { MethodResult, Principal, ServerRequest } from '@caxri/protocol';
import { CaxriError, MOBILE_AGENT_CHAT_IMAGE_CHUNK_LENGTH } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { ServerDomainService } from '../../domain-service';
import type { MobileDeviceRegistry } from '../device-registry';
import { isMobileGatewayMethodAllowedForRole } from '../role-methods';
import { admitMobileVideo, resolveMobileVideoFile } from './cited-video';
import type { RunCommand } from './poster';
import { createMobileVideoPosterReader } from './poster';
import { MobileVideoServer } from './server';

type VideoRequest = Extract<ServerRequest, { method: 'mobile.video.open' | 'mobile.video.read' }>;

/**
 * Shows and plays the videos a Chat message cites on a phone; see `docs/mobile/video.md`. The listener lives as long as
 * mobile access: the access controller clears it when the gateway is disabled or closed.
 */
export const createMobileVideoRequests = (options: {
    logger?: Pick<StructuredLogger, 'write'>;
    platform?: NodeJS.Platform;
    random: (bytes: number) => Uint8Array;
    registry: Pick<MobileDeviceRegistry, 'currentPrincipal'>;
    run?: RunCommand;
}) => {
    const server = new MobileVideoServer({
        authorize: ({ deviceId, generation }) => {
            try {
                const principal = options.registry.currentPrincipal(deviceId, generation);
                return (
                    principal.kind === 'paired-device' &&
                    isMobileGatewayMethodAllowedForRole(principal.role, 'mobile.video.open')
                );
            } catch {
                return false;
            }
        },
        ...(options.logger && { logger: options.logger }),
        random: options.random,
    });
    const readPoster = createMobileVideoPosterReader({
        ...(options.logger && { logger: options.logger }),
        ...(options.platform && { platform: options.platform }),
        ...(options.run && { run: options.run }),
    });
    return {
        clear: () => server.clear(),
        invoke: async (
            request: VideoRequest,
            principal: Extract<Principal, { kind: 'paired-device' }>,
            domainService: ServerDomainService,
            connectionAddress: () => string,
            reauthorize: () => void,
        ): Promise<MethodResult<VideoRequest['method']>> => {
            const { terminalId, itemId, path } = request.params;
            await admitMobileVideo(domainService, principal, { terminalId, itemId, path });
            const file = await resolveMobileVideoFile(path);
            reauthorize();
            if (request.method === 'mobile.video.open') {
                if (!file)
                    throw new CaxriError('NOT_FOUND', 'This video is no longer on the computer');
                const { deviceId, generation } = principal;
                return {
                    url: await server.open({ deviceId, generation }, connectionAddress(), {
                        path,
                        resolvedPath: file.path,
                    }),
                };
            }
            if (!file) return null;
            const poster = await readPoster(file);
            reauthorize();
            if (!poster) return { poster: null };
            const chunkCount = Math.max(
                1,
                Math.ceil(poster.data.length / MOBILE_AGENT_CHAT_IMAGE_CHUNK_LENGTH),
            );
            const { chunkIndex } = request.params;
            if (chunkIndex >= chunkCount)
                throw new CaxriError('VALIDATION', 'Poster chunk is out of range');
            const start = chunkIndex * MOBILE_AGENT_CHAT_IMAGE_CHUNK_LENGTH;
            return {
                poster: {
                    mediaType: poster.mediaType,
                    data: poster.data.slice(start, start + MOBILE_AGENT_CHAT_IMAGE_CHUNK_LENGTH),
                    chunkIndex,
                    chunkCount,
                },
            };
        },
    };
};
