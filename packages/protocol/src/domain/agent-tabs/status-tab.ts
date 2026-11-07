import { terminalTabPathCodec } from './terminal-tab-path.js';

/**
 * Virtual editor tab for one Agent Terminal's status: its output speed in detail and the public status of the
 * provider's services. Identity is the Terminal, so each Agent gets its own tab; the provider is resolved from the
 * Terminal at render time, never stored in the path.
 */
const agentStatusTab = terminalTabPathCodec('caxri-agent-status://');

export const agentStatusTabPath = agentStatusTab.path;
export const parseAgentStatusTab = agentStatusTab.parse;
export const isAgentStatusTabPath = agentStatusTab.is;
