import { StyleSheet } from 'react-native';

/**
 * Styles shared by the composer's model and permission sheets and their triggers.
 */
export const sheetStyles = StyleSheet.create({
    scroll: { flexGrow: 0 },
    section: {
        fontSize: 12,
        fontWeight: '700',
        letterSpacing: 0.4,
        paddingHorizontal: 10,
        paddingBottom: 4,
        paddingTop: 12,
        textTransform: 'uppercase',
    },
    option: {
        alignItems: 'center',
        borderRadius: 12,
        flexDirection: 'row',
        gap: 10,
        minHeight: 52,
        paddingHorizontal: 10,
        paddingVertical: 6,
    },
    optionText: { flex: 1, gap: 2 },
    optionLabel: { fontSize: 16 },
    optionDescription: { fontSize: 13, lineHeight: 18 },
    optionTrailing: { fontSize: 13 },
    optionMark: { alignItems: 'center', width: 24 },
    hint: { fontSize: 13, lineHeight: 18, paddingHorizontal: 10, paddingVertical: 6 },
    /**
     * The composer's model and permission triggers: 40dp rows above the input, grown to a 48dp target by hit slop.
     */
    trigger: {
        alignItems: 'center',
        alignSelf: 'flex-start',
        borderRadius: 8,
        flexDirection: 'row',
        gap: 6,
        maxWidth: '100%',
        minHeight: 40,
        paddingHorizontal: 8,
    },
    triggerText: { flexShrink: 1, fontSize: 13, fontWeight: '600' },
    triggerCaption: { fontSize: 13 },
});

/**
 * Grows a 40dp composer trigger to a 48dp touch target without making the composer taller.
 */
export const TRIGGER_HIT_SLOP = { top: 4, bottom: 4, left: 8, right: 8 } as const;
