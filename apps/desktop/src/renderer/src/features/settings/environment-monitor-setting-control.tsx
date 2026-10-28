import type { ReactNode } from 'react';

import type { AppSettings, SettingKey } from '@caxri/protocol';

import { EnvironmentMihomoRoutesForm } from './environment-mihomo-routes-form';
import { EnvironmentTimeZoneControl } from './environment-time-zone-control';

interface EnvironmentMonitorSettingControlOptions {
    controlId: string;
    key: SettingKey;
    label: string;
    settings: AppSettings;
    onChange: <K extends 'environmentMonitor.expectedTimeZone' | 'environmentMonitor.mihomoRoutes'>(
        key: K,
        value: AppSettings[K],
    ) => void;
}

/**
 * The two structured environment controls owned by Settings. Keeping them out of the generic row renderer prevents one
 * feature's editor layout from expanding the catalog-wide scalar dispatch.
 */
export function EnvironmentMonitorSettingControl({
    controlId,
    key,
    label,
    settings,
    onChange,
}: EnvironmentMonitorSettingControlOptions): ReactNode | undefined {
    if (key === 'environmentMonitor.expectedTimeZone')
        return (
            <EnvironmentTimeZoneControl
                id={controlId}
                label={label}
                value={settings['environmentMonitor.expectedTimeZone']}
                onChange={(value) => onChange('environmentMonitor.expectedTimeZone', value)}
            />
        );
    if (key === 'environmentMonitor.mihomoRoutes') {
        const value = settings['environmentMonitor.mihomoRoutes'];
        return (
            <EnvironmentMihomoRoutesForm
                value={value}
                onChange={(next) => onChange('environmentMonitor.mihomoRoutes', next)}
            />
        );
    }
    return undefined;
}
