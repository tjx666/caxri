import type { Principal, ServerRequest } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { ServerDomainService } from '../domain-service';
import type { MobileDeviceRegistry } from './device-registry';

type MobileProjectRequest = Extract<
    ServerRequest,
    { method: 'mobile.project.browse' | 'mobile.project.add' | 'mobile.project.reorder' }
>;

type MobileProjectReorderParameters = Extract<
    ServerRequest,
    { method: 'mobile.project.reorder' }
>['params'];

/**
 * Maps a phone's "before/after this neighbor" onto `project.reorder`'s index among every top-level Project, so Projects
 * the device cannot see keep their places relative to each other. Returns `undefined` when either Project is not a
 * current top-level Project.
 */
function mobileProjectReorderTargetIndex(
    topLevelProjectIds: readonly string[],
    { projectId, anchorProjectId, placement }: MobileProjectReorderParameters,
): number | undefined {
    if (projectId === anchorProjectId || !topLevelProjectIds.includes(projectId)) return undefined;
    const remaining = topLevelProjectIds.filter((id) => id !== projectId);
    const anchorIndex = remaining.indexOf(anchorProjectId);
    if (anchorIndex === -1) return undefined;
    return placement === 'before' ? anchorIndex : anchorIndex + 1;
}

/**
 * Browses the Mac's home directory for a new Project, adds one, or reorders granted Projects, from a `control` device.
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
    if (request.method === 'mobile.project.reorder') {
        const { projectId, anchorProjectId } = request.params;
        if (
            !principal.projectIds.includes(projectId) ||
            !principal.projectIds.includes(anchorProjectId)
        )
            throw new CaxriError('NOT_FOUND', 'Project not found');
        const { projects } = await domainService.request('project.list', {});
        const targetIndex = mobileProjectReorderTargetIndex(
            projects
                // The in-process handler answers full Project records; the union type only narrows per view.
                .filter(
                    (project) =>
                        !('ownerProjectId' in project) || project.ownerProjectId === undefined,
                )
                .map(({ id }) => id),
            request.params,
        );
        if (targetIndex === undefined) throw new CaxriError('NOT_FOUND', 'Project not found');
        reauthorize();
        await domainService.request('project.reorder', { projectId, targetIndex });
        return null;
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
