import { StyleSheet } from 'react-native';

import { mobileControl, mobileRadius, mobileSpace, mobileType } from '../../../theme/scale';

export const sessionSidePanelStyles = StyleSheet.create({
    panelButton: {
        alignItems: 'center',
        borderRadius: mobileRadius.pill,
        height: 44,
        justifyContent: 'center',
        /**
         * Matches a toolbar `IconButton`, so it sits as close to the menu as the home header's actions do.
         */
        width: 40,
    },
    /**
     * Sits on the glyph's top-right corner, ringed in the header's background so it stays legible over the icon.
     */
    panelBadge: {
        ...mobileType.caption,
        borderRadius: mobileRadius.sm,
        borderWidth: 1.5,
        fontVariant: ['tabular-nums'],
        fontWeight: '700',
        minWidth: 18,
        overflow: 'hidden',
        paddingHorizontal: mobileSpace.xs,
        position: 'absolute',
        right: 0,
        textAlign: 'center',
        top: 2,
    },
    /**
     * Leaves a strip of the Session showing on the left, so the drawer reads as covering it rather than replacing it.
     */
    drawer: {
        borderLeftWidth: 1,
        bottom: 0,
        maxWidth: 420,
        position: 'absolute',
        right: 0,
        top: 0,
        width: '88%',
    },
    docked: { borderLeftWidth: 1, flex: 1, minWidth: 0 },
    header: {
        alignItems: 'center',
        borderBottomWidth: 1,
        flexDirection: 'row',
        gap: mobileSpace.xs,
        paddingRight: mobileSpace.xs,
        paddingVertical: mobileSpace.xs,
    },
    tabScroll: { flex: 1 },
    /**
     * When the tabs fit, `flexGrow` stretches the row to the panel's width so the tabs split the spare space and each
     * gets a wider touch target instead of crowding the left edge.
     */
    tabs: {
        flexDirection: 'row',
        flexGrow: 1,
        gap: mobileSpace.xs,
        paddingHorizontal: mobileSpace.sm,
    },
    tab: {
        alignItems: 'center',
        borderRadius: mobileRadius.pill,
        flexDirection: 'row',
        /**
         * Grows from its natural width rather than a zero basis: the spare width is shared equally, and the selected
         * tab keeps room for its name (`Changes` with a count would ellipsize in a strict equal split).
         */
        flexGrow: 1,
        flexShrink: 0,
        gap: mobileSpace.sm,
        justifyContent: 'center',
        minHeight: mobileControl.row,
        minWidth: mobileControl.row,
        paddingHorizontal: mobileSpace.md,
    },
    /**
     * Capped so a long extension panel name (`Extension Fixture`) ellipsizes instead of pushing the tabs after it out
     * of view; the fixed tabs' names fit inside the cap.
     */
    tabText: { ...mobileType.meta, flexShrink: 0, fontWeight: '600', maxWidth: 88 },
    tabBadge: {
        ...mobileType.caption,
        borderRadius: mobileRadius.sm,
        fontVariant: ['tabular-nums'],
        fontWeight: '700',
        overflow: 'hidden',
        paddingHorizontal: mobileSpace.xs,
    },
    attentionDot: {
        borderRadius: 5,
        borderWidth: 1.5,
        height: 10,
        position: 'absolute',
        right: 6,
        top: 6,
        width: 10,
    },
    body: { flex: 1, minWidth: 0 },
});
