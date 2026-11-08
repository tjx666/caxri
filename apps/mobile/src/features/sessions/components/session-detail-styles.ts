import { StyleSheet } from 'react-native';

import { mobileControl, mobileSpace, mobileType } from '../../../theme/scale';

/**
 * The composer is one capsule, as LobeHub's mobile composer: a 52dp row (`mobileControl.primary`) while it holds one
 * line, with its round buttons drawn at 44dp inside a 4dp inset. A button's 4dp hit slop reaches the capsule's edge, so
 * the whole 52dp stays the target.
 */
const COMPOSER_INSET = 4;
const COMPOSER_BUTTON = mobileControl.primary - 2 * COMPOSER_INSET;

export const sessionDetailStyles = StyleSheet.create({
    root: { flex: 1, minWidth: 0 },
    header: {
        borderBottomWidth: 1,
        paddingHorizontal: mobileSpace.xs,
        paddingVertical: mobileSpace.xs,
        zIndex: 2,
    },
    headerLine: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: mobileSpace.xs,
        minHeight: mobileControl.primary,
    },
    trailingActions: {
        alignItems: 'center',
        flexDirection: 'row',
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
    body: { flex: 1, minWidth: 0 },
    fallbackBanner: {
        ...mobileType.caption,
        borderBottomWidth: 1,
        paddingHorizontal: mobileSpace.lg,
        paddingVertical: mobileSpace.sm,
    },
    bodyRow: { flex: 1, flexDirection: 'row' },
    placeholder: {
        alignItems: 'center',
        flex: 1,
        gap: mobileSpace.sm,
        justifyContent: 'center',
        padding: mobileSpace.xl,
    },
    placeholderTitle: { ...mobileType.heading, textAlign: 'center' },
    placeholderBody: { ...mobileType.body, textAlign: 'center' },
    /**
     * The area under the body: notices, attachments, and menus stacked over the capsule. The capsule draws its own
     * edge, so the area has no divider above it.
     */
    composerBlock: { gap: 6, paddingBottom: 8, paddingHorizontal: 12, paddingTop: 4 },
    capsule: {
        borderRadius: mobileControl.primary / 2,
        borderWidth: 1,
        padding: COMPOSER_INSET - 1,
    },
    /**
     * A row inside the capsule. Buttons sit at the bottom, so a multi-line input grows upward beside them.
     */
    composerRow: { alignItems: 'flex-end', flexDirection: 'row', gap: COMPOSER_INSET },
    /**
     * The input sharing the collapsed row with the buttons: one 44dp line, growing to about six lines, then scrolling.
     */
    composer: {
        flex: 1,
        fontSize: 15,
        lineHeight: 21,
        maxHeight: 150,
        minHeight: COMPOSER_BUTTON,
        paddingHorizontal: 8,
        paddingVertical: 11,
    },
    /**
     * The input across the top of an expanded capsule, inset to line up with the add button's glyph below it.
     */
    composerExpanded: {
        fontSize: 15,
        lineHeight: 21,
        maxHeight: 150,
        minHeight: COMPOSER_BUTTON,
        paddingBottom: 6,
        paddingHorizontal: 12,
        paddingTop: 11,
    },
    composerMeta: { flexDirection: 'row', gap: 8, justifyContent: 'space-between' },
    reason: { flex: 1, fontSize: 12, lineHeight: 18 },
    byteCount: { fontSize: 12 },
    sendButton: {
        alignItems: 'center',
        borderRadius: COMPOSER_BUTTON / 2,
        height: COMPOSER_BUTTON,
        justifyContent: 'center',
        width: COMPOSER_BUTTON,
    },
    sendState: mobileType.meta,
    surfaceSwitchState: { alignItems: 'center', flexDirection: 'row', gap: mobileSpace.sm },
});
