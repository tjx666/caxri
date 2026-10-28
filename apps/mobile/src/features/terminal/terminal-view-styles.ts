import { StyleSheet } from 'react-native';

import { mobileRadius, mobileSpace, mobileType } from '../../theme/scale';

/**
 * The drop shadow of a floating Terminal control. The color comes from the theme's `shadow` role at the call site,
 * since a static stylesheet cannot read the theme.
 */
export const floatingShadow = (shadowColor: string): string => `0px 2px 8px ${shadowColor}`;

export const terminalViewStyles = StyleSheet.create({
    root: { flex: 1, minWidth: 0 },
    screen: { flex: 1, minHeight: 140 },
    webview: { flex: 1, backgroundColor: 'transparent' },
    status: { paddingHorizontal: mobileSpace.md, paddingVertical: mobileSpace.sm },
    statusText: { ...mobileType.meta, flexShrink: 1 },
    statusChip: {
        alignItems: 'center',
        alignSelf: 'center',
        borderRadius: mobileRadius.lg,
        borderWidth: 1,
        flexDirection: 'row',
        gap: mobileSpace.xs,
        maxWidth: '92%',
        minHeight: 32,
        paddingLeft: mobileSpace.md,
        paddingRight: mobileSpace.xs,
        position: 'absolute',
        top: mobileSpace.sm,
    },
    /**
     * The one-line note that a control device took over the Terminal size, bottom left so it never covers the status
     * chip at the top or the actions at the right.
     */
    leaseHint: {
        alignItems: 'center',
        borderRadius: mobileRadius.pill,
        borderWidth: 1,
        bottom: mobileSpace.md,
        justifyContent: 'center',
        left: mobileSpace.md,
        maxWidth: '55%',
        minHeight: 32,
        paddingHorizontal: mobileSpace.md,
        position: 'absolute',
    },
    floating: {
        alignItems: 'center',
        bottom: mobileSpace.md,
        flexDirection: 'row',
        gap: mobileSpace.md,
        position: 'absolute',
        right: mobileSpace.md,
    },
    floatingRound: {
        alignItems: 'center',
        borderRadius: mobileRadius.pill,
        borderWidth: 1,
        height: 44,
        justifyContent: 'center',
        width: 44,
    },
    floatingPill: {
        alignItems: 'center',
        borderRadius: mobileRadius.pill,
        flexDirection: 'row',
        gap: mobileSpace.sm,
        height: 44,
        paddingHorizontal: mobileSpace.lg,
    },
    floatingLabel: { ...mobileType.bodyStrong },
    takeOverGroup: { alignItems: 'flex-end', gap: 6 },
    takeOverCaption: {
        borderRadius: mobileRadius.sm,
        maxWidth: 180,
        paddingHorizontal: mobileSpace.sm,
        paddingVertical: mobileSpace.xxs,
    },
    takeOverCaptionText: { ...mobileType.caption, textAlign: 'right' },
    hiddenInput: { height: 1, left: -100, opacity: 0, position: 'absolute', width: 1 },
    controlBar: {
        alignItems: 'center',
        borderTopWidth: 1,
        flexDirection: 'row',
        paddingRight: mobileSpace.sm,
    },
    // 44 key height + 6px top/bottom `keyBarContent` padding, so a 44dp key never clips against this cap.
    keyBar: { flex: 1, flexGrow: 1, maxHeight: 56 },
    keyBarContent: {
        alignItems: 'center',
        gap: mobileSpace.xs,
        paddingHorizontal: mobileSpace.sm,
        paddingVertical: 6,
    },
    key: {
        alignItems: 'center',
        borderRadius: mobileRadius.sm,
        justifyContent: 'center',
        minHeight: 44,
        minWidth: 42,
        paddingHorizontal: 10,
    },
    keyLabel: { ...mobileType.bodyStrong },
    /**
     * Release is a labeled pill, not a bare glyph, so it never reads as a second keyboard control.
     */
    releaseButton: {
        alignItems: 'center',
        borderRadius: mobileRadius.pill,
        borderWidth: 1,
        flexDirection: 'row',
        gap: mobileSpace.xs,
        height: 40,
        marginLeft: mobileSpace.xs,
        paddingHorizontal: mobileSpace.md,
    },
    releaseLabel: { ...mobileType.meta, fontWeight: '600' },
});
