import type {
    MobileDesktopUpdateImpact,
    MobileDesktopUpdateResult,
    RemoteUpdateInstallResult,
    ServerRequest,
    UpdateState,
} from '@caxri/protocol';

import type { ServerDesktopRouter } from '../desktop-router';
import type { ServerDomainService } from '../domain-service';

type DesktopUpdatePort = Pick<ServerDesktopRouter, 'installUpdate' | 'update'>;

type MobileDesktopUpdateRequest = Extract<
    ServerRequest,
    {
        method:
            | 'mobile.desktopUpdate.download'
            | 'mobile.desktopUpdate.install'
            | 'mobile.desktopUpdate.read';
    }
>;

/**
 * What a restart ends, read from the domain like Desktop's own `Restart and Update?` prompt reads it. Review comments
 * fail open to zero, as they do there: an unreadable reminder must not hide the restart.
 */
async function readPendingReviewComments(domainService: ServerDomainService): Promise<number> {
    try {
        return (await domainService.request('gitReview.pending', {})).count;
    } catch {
        return 0;
    }
}

async function readImpact(domainService: ServerDomainService): Promise<MobileDesktopUpdateImpact> {
    const [running, pendingReviewComments] = await Promise.all([
        domainService.request('terminal.runningCount'),
        readPendingReviewComments(domainService),
    ]);
    return {
        terminals: running.terminals,
        chats: running.chats,
        pendingReviewComments,
    };
}

async function project(
    state: UpdateState | 'offline' | 'unsupported',
    domainService: ServerDomainService,
): Promise<MobileDesktopUpdateResult> {
    if (state === 'offline' || state === 'unsupported') return { desktop: state };
    if (state.status !== 'ready') return { desktop: 'online', state };
    return { desktop: 'online', state, impact: await readImpact(domainService) };
}

/**
 * `mobile.desktopUpdate.*`: the phone's view of, and control over, Caxri's own update on the paired computer. Server
 * Core only relays: Desktop Main owns discovery, download, verification, and the restart.
 */
export async function invokeMobileDesktopUpdateRequest(
    request: MobileDesktopUpdateRequest,
    desktop: DesktopUpdatePort | undefined,
    domainService: ServerDomainService,
): Promise<MobileDesktopUpdateResult | RemoteUpdateInstallResult> {
    if (request.method === 'mobile.desktopUpdate.install')
        return desktop
            ? desktop.installUpdate(request.params.version)
            : { outcome: 'blocked', reason: 'desktop-offline' };
    if (!desktop) return { desktop: 'offline' };
    const action =
        request.method === 'mobile.desktopUpdate.download'
            ? 'download'
            : request.params.check
              ? 'check'
              : 'read';
    return project(await desktop.update(action), domainService);
}
