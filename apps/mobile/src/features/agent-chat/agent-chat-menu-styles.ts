import { StyleSheet } from 'react-native';

import { mobileControl, mobileRadius, mobileSpace, mobileType } from '../../theme/scale';
import { MOBILE_AGENT_CHAT_COMMAND_ROWS } from './agent-chat-commands';

const ROW_HEIGHT = mobileControl.row;

/**
 * The `/` and `@` menus' shared look above the Chat input.
 */
export const agentChatMenuStyles = StyleSheet.create({
    list: {
        borderRadius: mobileRadius.md,
        borderWidth: StyleSheet.hairlineWidth,
        maxHeight: ROW_HEIGHT * MOBILE_AGENT_CHAT_COMMAND_ROWS,
        overflow: 'hidden',
    },
    heading: {
        ...mobileType.caption,
        fontWeight: '600',
        paddingHorizontal: mobileSpace.md,
        paddingTop: mobileSpace.sm,
        paddingBottom: mobileSpace.xxs,
        textTransform: 'uppercase',
    },
    row: {
        justifyContent: 'center',
        minHeight: ROW_HEIGHT,
        paddingHorizontal: mobileSpace.md,
        paddingVertical: mobileSpace.xs,
    },
    name: { ...mobileType.bodyStrong },
    detail: { ...mobileType.meta },
    notice: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: mobileSpace.sm,
        minHeight: ROW_HEIGHT,
        paddingHorizontal: mobileSpace.md,
    },
    noticeText: { ...mobileType.meta },
});
