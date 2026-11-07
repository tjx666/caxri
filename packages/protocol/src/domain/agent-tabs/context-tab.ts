import { terminalTabPathCodec } from './terminal-tab-path.js';

/**
 * Virtual editor tab for one Chat Terminal's context: what fills the window item by item and how the prompt cache held
 * up. Identity is the Terminal, so each Chat gets its own tab.
 */
const agentContextTab = terminalTabPathCodec('caxri-agent-context://');

export const agentContextTabPath = agentContextTab.path;
export const parseAgentContextTab = agentContextTab.parse;
export const isAgentContextTabPath = agentContextTab.is;
