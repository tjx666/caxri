import { StyleSheet } from 'react-native';

import { mobileControl, mobileSpace, mobileType } from '../../theme/scale';

export const addProjectStyles = StyleSheet.create({
    root: { flex: 1 },
    list: { flex: 1 },
    listContent: {
        alignSelf: 'center',
        flexGrow: 1,
        maxWidth: 680,
        paddingHorizontal: mobileSpace.md,
        width: '100%',
    },
    row: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: mobileSpace.sm,
        minHeight: mobileControl.row,
    },
    rowMain: {
        alignItems: 'center',
        flex: 1,
        flexDirection: 'row',
        gap: mobileSpace.md,
        minHeight: mobileControl.row,
        minWidth: 0,
        paddingHorizontal: mobileSpace.sm,
    },
    rowTitle: { ...mobileType.body, flex: 1, minWidth: 0 },
    truncated: { ...mobileType.meta, padding: mobileSpace.md, textAlign: 'center' },
    footer: {
        borderTopWidth: 1,
        gap: mobileSpace.sm,
        paddingHorizontal: mobileSpace.lg,
        paddingVertical: mobileSpace.md,
    },
    error: mobileType.meta,
    hint: { ...mobileType.meta, textAlign: 'center' },
});
