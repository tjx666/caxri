import { StyleSheet } from 'react-native';

import { mobileControl, mobileRadius, mobileSpace, mobileType } from '../../../theme/scale';

/**
 * Send and Stop are the composer's primary action, which the mobile design sizes at 52dp; the one-line input matches it
 * so the row stays aligned.
 */
const COMPOSER_LINE_HEIGHT = 52;

export const sessionDetailStyles = StyleSheet.create({
    root: { flex: 1, minWidth: 0 },
    header: { paddingHorizontal: mobileSpace.xs, paddingVertical: mobileSpace.xs, zIndex: 2 },
    headerLine: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: mobileSpace.xs,
        minHeight: mobileControl.primary,
    },
    titleGroup: {
        alignItems: 'center',
        flex: 1,
        flexDirection: 'row',
        gap: mobileSpace.sm,
        minWidth: 0,
        paddingHorizontal: mobileSpace.sm,
    },
    title: { ...mobileType.heading, flexShrink: 1 },
    tabStrip: { borderBottomWidth: 1, flexGrow: 0 },
    tabs: {
        flexDirection: 'row',
        gap: mobileSpace.sm,
        paddingBottom: mobileSpace.sm,
        paddingHorizontal: mobileSpace.lg,
    },
    tab: {
        alignItems: 'center',
        borderRadius: mobileRadius.pill,
        flexDirection: 'row',
        flexShrink: 0,
        gap: mobileSpace.sm,
        justifyContent: 'center',
        minHeight: mobileControl.row,
        minWidth: mobileControl.row,
        paddingHorizontal: mobileSpace.md,
    },
    tabText: { ...mobileType.meta, flexShrink: 0, fontWeight: '600' },
    tabAttentionDot: {
        borderRadius: 5,
        borderWidth: 1.5,
        height: 10,
        position: 'absolute',
        right: -4,
        top: -3,
        width: 10,
    },
    tabBadge: {
        ...mobileType.caption,
        borderRadius: mobileRadius.sm,
        fontVariant: ['tabular-nums'],
        fontWeight: '700',
        overflow: 'hidden',
        paddingHorizontal: mobileSpace.xs,
    },
    body: { flex: 1, minWidth: 0 },
    fallbackBanner: {
        ...mobileType.caption,
        borderBottomWidth: 1,
        paddingHorizontal: mobileSpace.lg,
        paddingVertical: mobileSpace.sm,
    },
    bodyRow: { flex: 1, flexDirection: 'row' },
    wideChanges: { borderLeftWidth: 1, flex: 1, minWidth: 0 },
    placeholder: {
        alignItems: 'center',
        flex: 1,
        gap: mobileSpace.sm,
        justifyContent: 'center',
        padding: mobileSpace.xl,
    },
    placeholderTitle: { ...mobileType.heading, textAlign: 'center' },
    placeholderBody: { ...mobileType.body, textAlign: 'center' },
    composerBlock: { borderTopWidth: 1, gap: 6, paddingHorizontal: 12, paddingVertical: 10 },
    composerRow: { alignItems: 'flex-end', flexDirection: 'row', gap: 8 },
    /**
     * Centers the 44dp attach button on the input's first line, matching the 52dp Send button beside it.
     */
    attachSlot: { height: COMPOSER_LINE_HEIGHT, justifyContent: 'center' },
    composer: {
        borderRadius: COMPOSER_LINE_HEIGHT / 2,
        borderWidth: 1,
        fontSize: 15,
        flex: 1,
        lineHeight: 21,
        maxHeight: 150,
        minHeight: COMPOSER_LINE_HEIGHT,
        paddingHorizontal: 16,
        paddingVertical: 14,
    },
    composerMeta: { flexDirection: 'row', gap: 8, justifyContent: 'space-between' },
    reason: { flex: 1, fontSize: 12, lineHeight: 18 },
    byteCount: { fontSize: 12 },
    sendButton: {
        alignItems: 'center',
        borderRadius: COMPOSER_LINE_HEIGHT / 2,
        height: COMPOSER_LINE_HEIGHT,
        justifyContent: 'center',
        width: COMPOSER_LINE_HEIGHT,
    },
    sendState: mobileType.meta,
    surfaceSwitchState: { alignItems: 'center', flexDirection: 'row', gap: mobileSpace.sm },
});
