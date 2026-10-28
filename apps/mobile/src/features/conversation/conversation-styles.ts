import { StyleSheet } from 'react-native';

import { MONOSPACE_FONT } from '../../theme/monospace';
import { mobileControl, mobileRadius, mobileSpace, mobileType } from '../../theme/scale';

const JUMP_SIZE = mobileControl.row;
const JUMP_BOTTOM_OFFSET = mobileSpace.md;

/**
 * The room the jump-to-latest button takes at the viewport's bottom. The list ends with this much padding, so a reader
 * who scrolls up just far enough to bring the button out finds the last message's final line above it instead of under
 * it.
 */
const JUMP_CLEARANCE = JUMP_SIZE + JUMP_BOTTOM_OFFSET;

export const conversationStyles = StyleSheet.create({
    root: { flex: 1, minWidth: 0 },
    list: { flex: 1 },
    /**
     * The timeline column's gutter is 16dp, the same as the docks above the composer.
     */
    listContent: {
        paddingBottom: JUMP_CLEARANCE,
        paddingHorizontal: mobileSpace.lg,
        paddingTop: mobileSpace.lg,
    },
    /**
     * FlashList positions cells itself and ignores `gap` on its content container, so each cell owns its spacing.
     */
    entry: { paddingBottom: mobileSpace.lg },
    message: { maxWidth: 680, width: '100%', alignSelf: 'center' },
    userRow: { alignItems: 'flex-end', gap: mobileSpace.sm },
    userBubble: {
        borderRadius: mobileRadius.lg,
        maxWidth: '85%',
        paddingHorizontal: mobileSpace.lg,
        paddingVertical: mobileSpace.md,
    },
    userText: mobileType.body,
    agentText: mobileType.body,
    toolGroup: { borderRadius: mobileRadius.md, borderWidth: 1, overflow: 'hidden' },
    toolRow: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: mobileSpace.sm,
        minHeight: mobileControl.row,
        paddingHorizontal: mobileSpace.md,
    },
    toolIcon: {
        alignItems: 'center',
        borderRadius: mobileRadius.sm,
        height: 28,
        justifyContent: 'center',
        width: 28,
    },
    toolLabel: { ...mobileType.meta, flexShrink: 0, fontWeight: '500', maxWidth: '45%' },
    /**
     * A running row's whole title (verb and subject) as one line under the activity highlight.
     */
    toolTitle: { flex: 1, minWidth: 0 },
    /**
     * A row with an activity line: the title line above it, both sharing the space between glyph and trailing facts.
     */
    toolTitleStack: { flex: 1, gap: mobileSpace.xxs, minWidth: 0, paddingVertical: mobileSpace.sm },
    toolTitleLine: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: mobileSpace.sm,
        minWidth: 0,
    },
    toolActivity: mobileType.caption,
    toolLiveLabel: { ...mobileType.meta, fontWeight: '500' },
    toolSubject: { ...mobileType.meta, flex: 1, minWidth: 0 },
    toolSummaryText: mobileType.meta,
    toolChipSlot: { alignItems: 'flex-start', flex: 1, minWidth: 0 },
    toolChip: {
        borderRadius: mobileRadius.sm,
        maxWidth: '100%',
        paddingHorizontal: mobileSpace.sm,
        paddingVertical: mobileSpace.xs,
    },
    toolChipText: { ...mobileType.caption, fontFamily: MONOSPACE_FONT },
    toolSpacer: { flex: 1 },
    toolDuration: { ...mobileType.caption, fontVariant: ['tabular-nums'] },
    toolChildren: { borderTopWidth: 1, paddingLeft: mobileSpace.md },
    /**
     * Inside a `Card` (which owns the border, radius, and fill). An event with detail or a clipped summary also has
     * `eventRowExpandable`, which lifts the row to the 48dp touch minimum.
     */
    eventRow: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: mobileSpace.sm,
        minHeight: 40,
        paddingHorizontal: mobileSpace.md,
        paddingVertical: mobileSpace.sm,
    },
    eventRowExpandable: { minHeight: mobileControl.row },
    eventSummaryFrame: { flex: 1, minWidth: 0 },
    eventSummary: mobileType.meta,
    eventSummaryProbe: { left: 0, opacity: 0, position: 'absolute', right: 0, top: 0 },
    eventDetail: {
        ...mobileType.caption,
        borderRadius: mobileRadius.sm,
        fontFamily: MONOSPACE_FONT,
        lineHeight: 17,
        marginTop: mobileSpace.sm,
        padding: mobileSpace.md,
    },
    /**
     * A small centered caption, like a chat app's time stamp, so turn boundaries stay out of the reading flow.
     */
    turnDivider: { alignItems: 'center', paddingVertical: mobileSpace.xxs },
    turnPill: {
        borderRadius: mobileRadius.sm,
        paddingHorizontal: mobileSpace.sm,
        paddingVertical: mobileSpace.xxs,
    },
    turnText: mobileType.caption,
    status: {
        alignItems: 'center',
        flex: 1,
        gap: mobileSpace.md,
        justifyContent: 'center',
        padding: mobileSpace.xl,
    },
    statusText: { ...mobileType.body, textAlign: 'center' },
    stateButton: { minWidth: 96 },
    // 48dp: the mobile minimum touch target (docs/mobile/design.md). The shadow color comes from `theme.shadow`.
    jump: {
        alignItems: 'center',
        borderRadius: JUMP_SIZE / 2,
        borderWidth: 1,
        bottom: JUMP_BOTTOM_OFFSET,
        height: JUMP_SIZE,
        justifyContent: 'center',
        position: 'absolute',
        right: mobileSpace.lg,
        width: JUMP_SIZE,
    },
    history: { alignItems: 'center', gap: mobileSpace.sm, paddingBottom: mobileSpace.sm },
    historyText: { ...mobileType.caption, textAlign: 'center' },
    /**
     * Flexes inside the sheet's height cap so the detail body scrolls instead of overflowing.
     */
    detailContent: { flexShrink: 1, paddingHorizontal: mobileSpace.sm },
    detailHeader: { alignItems: 'center', flexDirection: 'row', gap: mobileSpace.sm },
    detailTitle: { ...mobileType.heading, flex: 1 },
    detailCloseButton: {
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: mobileControl.row,
        minWidth: mobileControl.row,
    },
    detailClose: mobileType.bodyStrong,
    detailSubject: {
        ...mobileType.caption,
        borderRadius: mobileRadius.sm,
        fontFamily: MONOSPACE_FONT,
        lineHeight: 18,
        marginTop: mobileSpace.lg,
        paddingHorizontal: mobileSpace.md,
        paddingVertical: mobileSpace.sm,
    },
    detailBody: {
        ...mobileType.meta,
        fontFamily: MONOSPACE_FONT,
        lineHeight: 20,
        paddingTop: mobileSpace.lg,
    },
});
