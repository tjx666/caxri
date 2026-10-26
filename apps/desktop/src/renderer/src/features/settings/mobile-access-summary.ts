import type { MobileAccessStatus, MobileDeviceSummary, ProjectQueryResult } from '@caxri/protocol';
import { isCaxriError, isTopLevelProject, MOBILE_PAIRING_TTL_MS } from '@caxri/protocol';

import type { Translate, TranslationKey } from '../../i18n';

/**
 * Separates the Projects a pairing can grant (the PrimarySidebar's top-level Projects) from auto-registered worktree
 * Projects. A paired device never lists a worktree Project, so offering one in the pairing checklist only spent a grant
 * slot on an entry the phone hides; the ids are kept so an older device's Access line can skip them. Only the Desktop
 * view carries `ownerProjectId`; a scoped view has nothing to split.
 */
export function splitGrantableProjects(result: ProjectQueryResult): {
    projects: ProjectQueryResult['projects'];
    worktreeProjectIds: ReadonlySet<string>;
} {
    if (result.view !== 'desktop' && result.view !== 'human-cli')
        return { projects: result.projects, worktreeProjectIds: new Set() };
    return {
        projects: result.projects.filter((project) => isTopLevelProject(project)),
        worktreeProjectIds: new Set(
            result.projects
                .filter((project) => !isTopLevelProject(project))
                .map((project) => project.id),
        ),
    };
}

/**
 * A paired device's `Access:` line used to repeat the literal `Unavailable Project` once per grant the current window
 * cannot resolve: a device with several stale grants read as `Unavailable Project, Unavailable Project, …`, which is
 * also what stretched the Paired devices card past the Settings content column (no single word to truncate against).
 * Collapsing every unresolved grant into one trailing `+N unavailable` keeps the line honest (the device still has that
 * many grants) without repeating a word that carries no new information after the first time.
 */
export function summarizeProjectAccess(
    t: Translate,
    titles: ReadonlyArray<string | undefined>,
): string {
    const known = titles.filter((title): title is string => title !== undefined);
    const unavailableCount = titles.length - known.length;
    if (unavailableCount === 0) return known.join(', ');
    const suffix = t('settings.mobileAccess.devices.unavailable', { count: unavailableCount });
    return known.length > 0 ? `${known.join(', ')} · ${suffix}` : suffix;
}

/**
 * Where a phone user downloads the Android build; kept here so the steps card and its test share one address.
 */
export const MOBILE_RELEASES_URL = 'https://github.com/tjx666/caxri/releases';

/**
 * How long a pairing code stays valid, as shown in the "Getting the app" steps.
 */
export const MOBILE_PAIRING_MINUTES = MOBILE_PAIRING_TTL_MS / 60_000;

export interface MobileStatusView {
    detailKey: TranslationKey;
    detailParams?: Record<string, number | string>;
    titleKey: TranslationKey;
}

/**
 * Builds the status card copy from one decision table so the title and detail can never contradict each other: the
 * listener address is only named when access is on and the Server published an endpoint, and an "on" switch without an
 * endpoint says it is still waiting rather than claiming a listener exists.
 */
export function describeMobileStatus(
    status: Pick<MobileAccessStatus, 'address' | 'enabled' | 'port'>,
    activeDeviceCount: number,
): MobileStatusView {
    if (!status.enabled)
        return {
            detailKey: 'settings.mobileAccess.status.offDetail',
            titleKey: 'settings.mobileAccess.status.off',
        };
    if (!status.address || !status.port)
        return {
            detailKey: 'settings.mobileAccess.status.waitingDetail',
            titleKey: 'settings.mobileAccess.status.on',
        };
    return {
        detailKey:
            activeDeviceCount === 1
                ? 'settings.mobileAccess.status.listeningOne'
                : 'settings.mobileAccess.status.listeningOther',
        detailParams: { address: status.address, count: activeDeviceCount, port: status.port },
        titleKey: 'settings.mobileAccess.status.available',
    };
}

/**
 * Maps a failed Mobile access request to the most specific user-facing copy. The Server reports these closed reasons as
 * `UNAVAILABLE` errors whose messages are fixed strings (see `gateway/address-selection.ts` and `gateway/bind.ts`), so
 * the message is the only reason signal the Renderer receives; anything unrecognized keeps the action's generic copy.
 */
export function describeMobileFailure(error: unknown, fallback: TranslationKey): TranslationKey {
    if (!isCaxriError(error)) return fallback;
    const message = error.message.toLowerCase();
    if (message.includes('no private ipv4 network'))
        return 'settings.mobileAccess.error.noPrivateNetwork';
    if (message.includes('already in use')) return 'settings.mobileAccess.error.portBusy';
    if (message.includes('could not open a local network endpoint'))
        return 'settings.mobileAccess.error.endpointFailed';
    return fallback;
}

/**
 * True when the pairing link advertises a Tailscale address (100.64.0.0/10), so the card can say the code also works
 * away from home. Parses the `addresses` query parameter and never throws on a malformed link.
 */
export function isTailscalePairingLink(pairingLink: string): boolean {
    let addresses: string | null;
    try {
        addresses = new URL(pairingLink).searchParams.get('addresses');
    } catch {
        return false;
    }
    return (addresses ?? '').split(',').some((address) => {
        const octets = address.split('.').map(Number);
        // Tailscale assigns addresses from the 100.64.0.0/10 CGNAT range.
        return octets.length === 4 && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
    });
}

/**
 * The name of the device that appeared after a pairing code was issued, or undefined while none has. Revoked devices
 * and devices that were already paired when the code was created do not count.
 */
export function findNewlyPairedDevice(
    devices: ReadonlyArray<Pick<MobileDeviceSummary, 'deviceId' | 'displayName' | 'revokedAt'>>,
    knownDeviceIds: ReadonlySet<string>,
): string | undefined {
    return devices.find(
        (device) => device.revokedAt === undefined && !knownDeviceIds.has(device.deviceId),
    )?.displayName;
}
