import { isCaxriError } from '@caxri/protocol';

import { translate } from '../../i18n';
import { describeFailureKey } from '../../stores/toasts';

/**
 * What the last Import Theme attempt did, reported inside the dialog rather than through a toast.
 *
 * A toast was the wrong channel twice over: success said nothing at all, and a failure landed in a surface the open
 * dialog's focus trap keeps out of Tab order (DESIGN.md: "a failure the dialog can report in place belongs in the
 * dialog"). Both answers now render at the top of the theme editor, where the button that asked for them is.
 */
export type ThemeImportResult =
    { kind: 'imported'; themeName: string } | { kind: 'failed'; message: string };

const BACKGROUND_ROLES = ['background', 'surface', 'elevated'] as const;

/**
 * Called from the import handler, outside render, so it reads the active locale through `translate()`. Only known theme
 * roles from the Server's validation details become visible CSS token names.
 */
export function describeThemeImportFailure(error: unknown): string {
    if (!isCaxriError(error) || error.code !== 'VALIDATION')
        return describeFailureKey(error, 'settings.themeEditor.importFailed', translate);

    const details = error.details;
    if (
        details?.kind !== 'theme-contrast' ||
        details.foregroundRole !== 'muted' ||
        BACKGROUND_ROLES.every((role) => role !== details.backgroundRole) ||
        typeof details.requiredRatio !== 'number' ||
        !Number.isFinite(details.requiredRatio) ||
        details.requiredRatio <= 0
    )
        return describeFailureKey(error, 'settings.themeEditor.importFailed', translate);

    const backgroundRole = details.backgroundRole as (typeof BACKGROUND_ROLES)[number];
    const actualRatio = details.actualRatio;
    if (actualRatio === null)
        return translate('settings.themeEditor.importFailedOpaque', {
            background: backgroundRole,
            required: details.requiredRatio,
        });
    if (typeof actualRatio !== 'number' || !Number.isFinite(actualRatio) || actualRatio < 0)
        return describeFailureKey(error, 'settings.themeEditor.importFailed', translate);

    return translate('settings.themeEditor.importFailedContrast', {
        actual: actualRatio.toFixed(2),
        background: backgroundRole,
        required: details.requiredRatio,
    });
}
