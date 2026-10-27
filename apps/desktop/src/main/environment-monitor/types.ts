import type { AppSettings } from '@caxri/protocol';

/**
 * Desktop Main-only environment monitor inputs and probe readings.
 */

export interface EnvironmentMonitorSignals {
    checkUnavailable: boolean;
    locationChanges: boolean;
    proxyProtection: boolean;
    publicIpChanges: boolean;
    timeZoneMismatch: boolean;
}

export interface EnvironmentEgressReading {
    countryCode?: string;
    ip: string;
    network?: string;
    region?: string;
    timeZone?: string;
}

interface EnvironmentProxyReading {
    /**
     * Only set when the selected route uses a loopback proxy that can be checked without contacting another host.
     */
    available?: boolean;
    route: string;
}

export interface EnvironmentMonitorProbeReading {
    egress?: EnvironmentEgressReading;
    proxy?: EnvironmentProxyReading;
}

export type EnvironmentMonitorProbe = (
    signals: EnvironmentMonitorSignals,
    signal: AbortSignal,
) => Promise<EnvironmentMonitorProbeReading>;

export function environmentMonitorSignalsFromSettings(
    settings: AppSettings,
): EnvironmentMonitorSignals {
    return {
        publicIpChanges: settings['environmentMonitor.publicIpChanges'],
        proxyProtection: settings['environmentMonitor.proxyProtection'],
        locationChanges: settings['environmentMonitor.locationChanges'],
        timeZoneMismatch: settings['environmentMonitor.timeZoneMismatch'],
        checkUnavailable: settings['environmentMonitor.checkUnavailable'],
    };
}

export function hasEnvironmentMonitorSignal(signals: EnvironmentMonitorSignals): boolean {
    return Object.values(signals).some(Boolean);
}

export function requiresExternalEnvironmentProbe(signals: EnvironmentMonitorSignals): boolean {
    return (
        signals.publicIpChanges ||
        signals.locationChanges ||
        signals.timeZoneMismatch ||
        signals.checkUnavailable
    );
}
