import type {
    EnvironmentMonitorIpProfile,
    EnvironmentMonitorIssue,
    EnvironmentMonitorState,
} from '@caxri/protocol';

import type { Translate } from '../../i18n';

export type EnvironmentChangeField =
    | 'publicIp'
    | 'country'
    | 'region'
    | 'city'
    | 'asn'
    | 'isp'
    | 'organization'
    | 'networkType'
    | 'operator'
    | 'riskScore'
    | 'anonymous'
    | 'compromised'
    | 'hosting'
    | 'proxy'
    | 'scraper'
    | 'tor'
    | 'vpn';

export interface EnvironmentChange {
    field: EnvironmentChangeField;
    previous: boolean | number | string;
    current: boolean | number | string;
}

export function environmentIssueLabel(
    issue: EnvironmentMonitorIssue,
    t: Translate,
    publicIp?: EnvironmentMonitorState['publicIp'],
): string {
    switch (issue.kind) {
        case 'publicIpChanged':
            return publicIp
                ? t('statusBar.environmentMonitor.issue.publicIpChangedDetail', {
                      current: publicIp.current.address,
                      previous: publicIp.baseline.address,
                  })
                : t('statusBar.environmentMonitor.issue.publicIpChanged');
        case 'timeZoneMismatch':
            return t('statusBar.environmentMonitor.issue.timeZoneMismatch', {
                actual: issue.actualTimeZone,
                expected: issue.expectedTimeZone,
            });
        case 'routeNodeMismatch':
            return t('statusBar.environmentMonitor.issue.routeNodeMismatch', {
                actual: issue.observedChain.join(' → '),
                domain: issue.domain,
                expected: issue.expectedNode,
            });
    }
}

function availableProfile(
    profile: EnvironmentMonitorIpProfile,
): Extract<EnvironmentMonitorIpProfile, { status: 'available' }> | undefined {
    return profile.status === 'available' ? profile : undefined;
}

/**
 * Exact facts that differ between the boot baseline and current exit. Metadata is compared only when both observations
 * have that field, so an unavailable provider response never masquerades as an environment change.
 */
export function environmentChanges(state: EnvironmentMonitorState): EnvironmentChange[] {
    const publicIp = state.publicIp;
    if (!publicIp) return [];
    const changes: EnvironmentChange[] = [];
    if (publicIp.baseline.address !== publicIp.current.address)
        changes.push({
            field: 'publicIp',
            previous: publicIp.baseline.address,
            current: publicIp.current.address,
        });

    const baseline = availableProfile(publicIp.baseline.profile);
    const current = availableProfile(publicIp.current.profile);
    if (!baseline || !current) return changes;

    for (const field of [
        'country',
        'region',
        'city',
        'asn',
        'isp',
        'organization',
        'networkType',
        'operator',
        'riskScore',
    ] as const) {
        const previous = baseline[field];
        const next = current[field];
        if (previous !== undefined && next !== undefined && previous !== next)
            changes.push({ field, previous, current: next });
    }
    for (const field of [
        'anonymous',
        'compromised',
        'hosting',
        'proxy',
        'scraper',
        'tor',
        'vpn',
    ] as const) {
        const previous = baseline.signals[field];
        const next = current.signals[field];
        if (previous !== undefined && next !== undefined && previous !== next)
            changes.push({ field, previous, current: next });
    }
    return changes;
}

export function locationLabel(profile: EnvironmentMonitorIpProfile): string | undefined {
    if (profile.status !== 'available') return undefined;
    return profile.city ?? profile.region ?? profile.country;
}

export function locationDetailLabel(profile: EnvironmentMonitorIpProfile): string | undefined {
    if (profile.status !== 'available') return undefined;
    const primary = locationLabel(profile);
    const parts = [profile.region, profile.country, profile.countryCode].filter(
        (value, index, values) =>
            value !== undefined && value !== primary && values.indexOf(value) === index,
    );
    return parts.length > 0 ? parts.join(' · ') : undefined;
}

export function networkLabel(profile: EnvironmentMonitorIpProfile): string | undefined {
    if (profile.status !== 'available') return undefined;
    return [profile.asn, profile.isp].filter(Boolean).join(' · ') || undefined;
}
