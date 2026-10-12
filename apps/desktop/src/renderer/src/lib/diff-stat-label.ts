import type { Translate } from '../i18n';
import { translate } from '../i18n';

/**
 * A `+N -M` changed-line pair in words, for accessible names and descriptions where bare signed digits would read as
 * arithmetic. Always the exact counts, never the compact display form. A component passes its own `t` so the label
 * follows a language change; the `translate` default serves callers outside React.
 */
export function diffStatLabel(
    stat: { additions: number; deletions: number },
    t: Translate = translate,
): string {
    return t(stat.additions === 1 ? 'core.diffStat.labelOne' : 'core.diffStat.labelOther', {
        additions: stat.additions,
        deletions: stat.deletions,
    });
}
