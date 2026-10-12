import { Text } from 'react-native';

import { formatLineCount, visibleDiffStatParts } from '@caxri/protocol';

import type { MobileTheme } from '../../theme/tokens';

/**
 * 60% alpha: nested `Text` ignores `opacity`, so the dimmed sign carries it in its color instead.
 */
const SIGN_ALPHA = '99';

/**
 * The inline `+N -M` changed-line pair, matching Desktop's `DiffStat`: balanced diff-stat colors, compact counts,
 * dimmed signs so the figures carry the weight, and a zero half beside a non-zero one dropped (`visibleDiffStatParts`).
 * Render it inside a parent `Text`, which owns font size and layout.
 */
export function ChangesDiffStat({
    additions,
    deletions,
    theme,
}: {
    additions: number;
    deletions: number;
    theme: MobileTheme;
}) {
    const visible = visibleDiffStatParts({ additions, deletions });
    return (
        <>
            {visible.additions ? (
                <Text style={{ color: theme.diffStatAdded }}>
                    <Text style={{ color: theme.diffStatAdded + SIGN_ALPHA }}>+</Text>
                    {formatLineCount(additions)}
                </Text>
            ) : null}
            {visible.additions && visible.deletions ? ' ' : null}
            {visible.deletions ? (
                <Text style={{ color: theme.diffStatRemoved }}>
                    <Text style={{ color: theme.diffStatRemoved + SIGN_ALPHA }}>-</Text>
                    {formatLineCount(deletions)}
                </Text>
            ) : null}
        </>
    );
}
