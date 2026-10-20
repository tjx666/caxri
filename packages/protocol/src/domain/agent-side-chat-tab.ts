import { terminalTabPathCodec } from './terminal-tab-path.js';

/**
 * Virtual editor tab for one Chat Terminal's side chat (Claude Code's `/btw`): quick questions answered from the Chat's
 * context beside the conversation. Identity is the Terminal, so each Chat has one side thread. The thread itself lives
 * only in Renderer memory; a restored tab starts empty.
 */
const agentSideChatTab = terminalTabPathCodec('caxri-agent-side-chat://');

export const agentSideChatTabPath = agentSideChatTab.path;
export const parseAgentSideChatTab = agentSideChatTab.parse;
export const isAgentSideChatTabPath = agentSideChatTab.is;
