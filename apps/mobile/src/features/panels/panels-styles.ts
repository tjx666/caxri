import { StyleSheet } from 'react-native';

import { MONOSPACE_FONT } from '../../theme/monospace';
import { mobileControl, mobileSpace, mobileType } from '../../theme/scale';

export const panelsStyles = StyleSheet.create({
    root: { flex: 1, minWidth: 0 },
    viewTitle: { ...mobileType.meta, fontWeight: '600', padding: mobileSpace.md },
    body: { flex: 1 },
    crumbs: {
        alignItems: 'center',
        borderBottomWidth: 1,
        flexDirection: 'row',
        gap: mobileSpace.sm,
        minHeight: mobileControl.row,
        paddingRight: mobileSpace.md,
    },
    crumbScroll: { flex: 1 },
    crumbTrail: { alignItems: 'center', gap: mobileSpace.xs, paddingRight: mobileSpace.xs },
    crumb: { alignItems: 'center', flexDirection: 'row', gap: mobileSpace.sm },
    crumbText: { ...mobileType.meta },
    /**
     * The editor toolbar: Edit, or Save and Discard, in one row under the breadcrumb.
     */
    fileActions: {
        alignItems: 'center',
        borderBottomWidth: StyleSheet.hairlineWidth,
        flexDirection: 'row',
        gap: mobileSpace.sm,
        paddingHorizontal: mobileSpace.lg,
        paddingVertical: mobileSpace.sm,
    },
    fileAction: { minWidth: 96 },
    fileActionNote: { ...mobileType.meta, flex: 1 },
    listNote: { ...mobileType.caption, padding: mobileSpace.lg, textAlign: 'center' },
    saveError: {
        ...mobileType.meta,
        paddingHorizontal: mobileSpace.lg,
        paddingVertical: mobileSpace.sm,
    },
    row: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: mobileSpace.md,
        minHeight: mobileControl.row,
        paddingHorizontal: mobileSpace.lg,
    },
    rowText: { ...mobileType.body, flex: 1, minWidth: 0 },
    /**
     * A tree row and its inline actions side by side, so the action pills take their own presses instead of the row's.
     */
    treeRowLine: { alignItems: 'center', flexDirection: 'row' },
    treeRowLabel: { flex: 1, minWidth: 0 },
    treeRowLabelWithActions: { paddingRight: mobileSpace.sm },
    treeActions: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: mobileSpace.xs,
        paddingRight: mobileSpace.lg,
    },
    treeChevron: { alignItems: 'center', marginRight: -mobileSpace.xs, width: mobileSpace.lg },
    symlinkBadge: {
        alignItems: 'center',
        borderRadius: 6,
        bottom: -2,
        height: 12,
        justifyContent: 'center',
        position: 'absolute',
        right: -2,
        width: 12,
    },
    rowDescription: { ...mobileType.caption, flexShrink: 1, maxWidth: '45%' },
    rowMeta: { ...mobileType.caption },
    preview: { flex: 1 },
    previewText: {
        ...mobileType.caption,
        fontFamily: MONOSPACE_FONT,
        lineHeight: 18,
        padding: mobileSpace.lg,
    },
});
