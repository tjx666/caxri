import type { AgentAction } from '@caxri/protocol';

import type { MobileTheme } from '../../theme/tokens';
import { AgentChatCommandList } from './agent-chat-command-list';
import type { AgentChatSkillNotice } from './agent-chat-commands';
import { AgentChatMentionList } from './agent-chat-mention-list';
import type { useAgentChatMentions } from './use-agent-chat-mentions';

/**
 * The composer's two menus above the capsule: the `/` command menu and the `@` mention list. At most one has rows for a
 * given draft, since each completes the token at the cursor.
 */
export const AgentChatComposerMenus = ({
    confirmsSendAsText,
    isEnabled,
    menu,
    mentions,
    onChooseCommand,
    theme,
}: {
    /**
     * A first Send on a `/name` nothing matches was held; a second Send on the same draft sends it as text.
     */
    confirmsSendAsText: boolean;
    isEnabled: boolean;
    menu: { matches: readonly AgentAction[] | undefined; notice: AgentChatSkillNotice | undefined };
    mentions: Pick<
        ReturnType<typeof useAgentChatMentions>,
        'choose' | 'isError' | 'isSearching' | 'preparingSessionId' | 'rows'
    >;
    onChooseCommand: (action: AgentAction) => void;
    theme: MobileTheme;
}) => (
    <>
        <AgentChatCommandList
            confirmsSendAsText={confirmsSendAsText}
            isEnabled={isEnabled}
            matches={menu.matches}
            notice={menu.notice}
            onChoose={onChooseCommand}
            theme={theme}
        />
        <AgentChatMentionList
            isEnabled={isEnabled}
            isError={mentions.isError}
            isSearching={mentions.isSearching}
            onChoose={(row) => {
                void mentions.choose(row);
            }}
            preparingSessionId={mentions.preparingSessionId}
            rows={mentions.rows}
            theme={theme}
        />
    </>
);
