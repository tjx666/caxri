import { StyleSheet } from 'react-native';

import { mobileControl, mobileRadius, mobileSpace, mobileType } from '../../theme/scale';

/**
 * Styles shared by the composer's sheets (Chat settings, Session usage) and their trigger row. One row recipe: a
 * `mobileControl.row` minimum height, a `body` label, and a `meta` detail line.
 */
export const sheetStyles = StyleSheet.create({
    scroll: { flexGrow: 0 },
    section: {
        paddingBottom: mobileSpace.xs,
        paddingHorizontal: mobileSpace.md,
        paddingTop: mobileSpace.lg,
    },
    option: {
        alignItems: 'center',
        borderRadius: mobileRadius.md,
        flexDirection: 'row',
        gap: mobileSpace.md,
        minHeight: mobileControl.row,
        paddingHorizontal: mobileSpace.md,
        paddingVertical: mobileSpace.sm,
    },
    optionText: { flex: 1, gap: mobileSpace.xxs },
    optionLabel: { ...mobileType.body },
    optionDescription: { ...mobileType.meta },
    optionTrailing: { ...mobileType.meta },
    optionMark: { alignItems: 'center', width: 24 },
    hint: {
        ...mobileType.meta,
        paddingHorizontal: mobileSpace.md,
        paddingVertical: mobileSpace.sm,
    },
    /**
     * The row above the composer input holding the settings and usage chips. The chips draw at 32dp and reach 48dp
     * through their hit slop; the `sm` gap keeps neighbouring slops from overlapping, so a tap lands on exactly one.
     */
    choices: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: mobileSpace.sm,
        paddingVertical: mobileSpace.xs,
    },
});
