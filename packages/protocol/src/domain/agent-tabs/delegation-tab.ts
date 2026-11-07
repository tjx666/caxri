import { terminalTabPathCodec } from './terminal-tab-path.js';

/**
 * Virtual editor tab for a delegated child's Agent Chat, opened beside the asking Chat when the user clicks the task's
 * record, so a consult (a second opinion, a review, computer use, an X search) is read and answered without leaving the
 * conversation that asked for it. Identity is the child's Chat Terminal, so the tab closes when that Chat does.
 */
const agentDelegationTab = terminalTabPathCodec('caxri-agent-delegation://');

export const agentDelegationTabPath = agentDelegationTab.path;
export const parseAgentDelegationTab = agentDelegationTab.parse;
export const isAgentDelegationTabPath = agentDelegationTab.is;
