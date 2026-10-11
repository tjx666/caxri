import type { Principal, ServerRequest } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { ServerDomainService } from '../domain-service';
import type { MobileDeviceRegistry } from './device-registry';

type MobileProjectRequest = Extract<
    ServerRequest,
    { method: 'mobile.project.browse' | 'mobile.project.add' }
>;

/**
 * Browses the Mac's home directory for a new Project, or adds one, from a `control` device.
 */
export async function invokeMobileProjectRequest(
    request: MobileProjectRequest,
    principal: Extract<Principal, { kind: 'paired-device' }>,
    domainService: ServerDomainService,
    registry: Pick<MobileDeviceRegistry, 'grantProject'>,
    reauthorize: () => unknown,
) {
    if (request.method === 'mobile.project.browse') {
        const result = await domainService.request('mobile.project.browseInternal', {
            ...request.params,
            principal,
        });
        reauthorize();
        return result;
    }
    const result = await domainService.request('mobile.project.addInternal', {
        ...request.params,
        principal,
    });
    /**
     * Grants the newly added Project to the requesting device. The live connection adopts the longer Project list
     * through `adoptCurrentPairedPrincipal` instead of treating it as a changed device.
     */
    await registry.grantProject(principal.deviceId, principal.generation, result.project.id);
    return result;
}

/**
 * Creates a pairing link only for Projects the requesting owner can see, so a link never grants a hidden Project.
 */
export async function createMobilePairing<T>(
    domainService: ServerDomainService,
    principal: Principal,
    request: Extract<ServerRequest, { method: 'mobile.pairing.create' }>,
    createPairing: (projectIds: string[]) => T,
): Promise<T> {
    const visible = await domainService.request('project.queryForPrincipal', {
        principal,
        query: { mode: 'list' },
    });
    const projectIds = new Set(visible.projects.map((project) => project.id));
    if (request.params.projectIds.some((projectId) => !projectIds.has(projectId)))
        throw new CaxriError('NOT_FOUND', 'Pairing Project not found');
    return createPairing(request.params.projectIds);
}
