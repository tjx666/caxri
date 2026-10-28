import { StyleSheet } from 'react-native';

/**
 * Send and Stop are the composer's primary action, which the mobile design sizes at 52dp; the one-line input matches it
 * so the row stays aligned.
 */
const COMPOSER_LINE_HEIGHT = 52;

export const sessionDetailStyles = StyleSheet.create({
    root: { flex: 1, minWidth: 0 },
    header: { paddingHorizontal: 4, paddingVertical: 4, zIndex: 2 },
    headerLine: { alignItems: 'center', flexDirection: 'row', gap: 4, minHeight: 52 },
    titleGroup: {
        alignItems: 'center',
        flex: 1,
        flexDirection: 'row',
        gap: 8,
        minWidth: 0,
        paddingHorizontal: 8,
    },
    title: { flexShrink: 1, fontSize: 17, fontWeight: '700' },
    menuAction: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 12,
        minHeight: 48,
        paddingHorizontal: 14,
    },
    menuActionText: { fontSize: 15 },
    tabStrip: { borderBottomWidth: 1, flexGrow: 0 },
    tabs: {
        flexDirection: 'row',
        gap: 6,
        paddingBottom: 8,
        paddingHorizontal: 12,
    },
    tab: {
        alignItems: 'center',
        borderRadius: 22,
        flexDirection: 'row',
        flexShrink: 0,
        gap: 6,
        justifyContent: 'center',
        minHeight: 44,
        minWidth: 48,
        paddingHorizontal: 12,
    },
    tabText: { flexShrink: 0, fontSize: 14, fontWeight: '600' },
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
        borderRadius: 8,
        fontSize: 12,
        fontVariant: ['tabular-nums'],
        fontWeight: '700',
        overflow: 'hidden',
        paddingHorizontal: 5,
    },
    body: { flex: 1, minWidth: 0 },
    fallbackBanner: {
        borderBottomWidth: 1,
        fontSize: 12,
        paddingHorizontal: 16,
        paddingVertical: 8,
    },
    bodyRow: { flex: 1, flexDirection: 'row' },
    wideChanges: { borderLeftWidth: 1, flex: 1, minWidth: 0 },
    placeholder: { alignItems: 'center', flex: 1, gap: 8, justifyContent: 'center', padding: 24 },
    placeholderTitle: { fontSize: 17, fontWeight: '700', textAlign: 'center' },
    placeholderBody: { fontSize: 14, lineHeight: 21, textAlign: 'center' },
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
    sendState: { fontSize: 13 },
    surfaceSwitchState: { alignItems: 'center', flexDirection: 'row', gap: 8 },
});
