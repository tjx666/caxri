/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { StyleSheet, View } from 'react-native';

import type { AgentChatPendingWait } from '@caxri/protocol';
import { parseAgentChatPathReferences } from '@caxri/protocol';

import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { ConversationHandoffCard } from '../conversation/conversation-handoff-card';
import { conversationStyles } from '../conversation/conversation-styles';
import { conversationUserText } from '../conversation/conversation-user-text';
import { ConversationUserWords } from '../conversation/conversation-user-words';
import { AgentChatFlightTile } from './agent-chat-image-flights';
import { AgentChatPathChips } from './agent-chat-path-chips';
import { AgentChatSendingClock } from './agent-chat-sending-clock';

const THUMBNAIL_SIZE = 96;

/**
 * A message on its way, laid out like the user message it becomes but faded, with Desktop's turning sending clock under
 * it (`AgentChatSendingClock`, which names what it waits for) and none of its actions, since nothing can act on a
 * message the conversation does not hold yet. Its images show from the prepared JPEGs still on the phone, and the files
 * it cites show as the chips the sent message will have.
 */
export const AgentChatPendingMessage = ({
    id,
    imageUris,
    text,
    theme,
    wait,
}: {
    id: string;
    imageUris: readonly string[];
    text: string;
    theme: MobileTheme;
    wait: AgentChatPendingWait;
}) => {
    const { t } = useTranslation();
    const cited = parseAgentChatPathReferences(text);
    // A `/new-session` hand-off shows as its card while it is on its way, never as the instructions for the Agent.
    const user = conversationUserText(cited.text);
    return (
        <View
            accessibilityState={{ busy: true }}
            style={[conversationStyles.message, conversationStyles.userRow]}
            testID={`agent-chat-pending-${id}`}
        >
            <View style={[conversationStyles.userRow, styles.pending]}>
                {/* No card can show a video before the message is sent, so its chip stands in until then. */}
                <AgentChatPathChips
                    hasVideoChips
                    references={cited.references}
                    skills={cited.skills}
                    theme={theme}
                />
                {cited.text.length > 0 || imageUris.length > 0 ? (
                    <View
                        style={[conversationStyles.userBubble, { backgroundColor: theme.surface }]}
                    >
                        {cited.text.length === 0 ? null : user.kind === 'handoff' ? (
                            <ConversationHandoffCard note={user.note} theme={theme} />
                        ) : (
                            <ConversationUserWords blocks={user.blocks} theme={theme} />
                        )}
                        {imageUris.length > 0 ? (
                            <View
                                style={[
                                    styles.images,
                                    cited.text.length > 0 && conversationStyles.userAttachments,
                                ]}
                            >
                                {imageUris.map((uri, index) => (
                                    <AgentChatFlightTile
                                        accessibilityLabel={t('chat.attachment', {
                                            number: index + 1,
                                        })}
                                        key={uri}
                                        style={[styles.thumbnail, { borderColor: theme.border }]}
                                        uri={uri}
                                    />
                                ))}
                            </View>
                        ) : null}
                    </View>
                ) : null}
            </View>
            <AgentChatSendingClock theme={theme} wait={wait} />
        </View>
    );
};

const styles = StyleSheet.create({
    pending: { alignSelf: 'stretch', opacity: 0.6 },
    images: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    thumbnail: {
        borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth,
        height: THUMBNAIL_SIZE,
        width: THUMBNAIL_SIZE,
    },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
