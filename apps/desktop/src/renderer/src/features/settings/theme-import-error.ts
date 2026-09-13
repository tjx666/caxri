import { isCaxriError } from '@caxri/protocol';

import { describeFailure } from '../../stores/toasts';

const BACKGROUND_ROLES = ['background', 'surface', 'elevated'] as const;

/**
 * Only known theme roles from the Server's validation details become visible CSS token names.
 */
export function describeThemeImportFailure(error: unknown): string {
    if (!isCaxriError(error) || error.code !== 'VALIDATION')
        return describeFailure(error, 'Theme import failed');

    const details = error.details;
    if (
        details?.kind !== 'theme-contrast' ||
        details.foregroundRole !== 'muted' ||
        BACKGROUND_ROLES.every((role) => role !== details.backgroundRole) ||
        typeof details.requiredRatio !== 'number' ||
        !Number.isFinite(details.requiredRatio) ||
        details.requiredRatio <= 0
    )
        return describeFailure(error, 'Theme import failed');

    const backgroundRole = details.backgroundRole as (typeof BACKGROUND_ROLES)[number];
    const actualRatio = details.actualRatio;
    if (actualRatio === null)
        return `Theme import failed. --muted and --${backgroundRole} must be opaque to check the required ${details.requiredRatio}:1 contrast.`;
    if (typeof actualRatio !== 'number' || !Number.isFinite(actualRatio) || actualRatio < 0)
        return describeFailure(error, 'Theme import failed');

    return `Theme import failed. --muted has ${actualRatio.toFixed(2)}:1 contrast against --${backgroundRole}; at least ${details.requiredRatio}:1 is required.`;
}
