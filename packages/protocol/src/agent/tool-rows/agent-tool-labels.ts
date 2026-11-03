import type { AgentChatLabelKey, AgentChatLabelTranslate } from '../agent-chat-labels.js';
import { translateAgentChatLabel } from '../agent-chat-labels.js';
import type { AgentShellCliLabel } from './agent-shell-cli.js';

/**
 * The catalog key of each English label in the tool table above, so a surface can show the label in the reader's
 * language while the presentation itself (stored in snapshots and sent to every client) stays English source data. A
 * label outside this table (an MCP server, an unknown tool's own name, or a Computer Use step's title) is an identifier
 * and stays as is.
 */
const TOOL_LABEL_KEYS: Readonly<Record<string, AgentChatLabelKey>> = {
    'Ran': 'agentChat.tool.label.ran',
    'Checked output': 'agentChat.tool.label.checkedOutput',
    'Sent input': 'agentChat.tool.label.sentInput',
    'Stopped': 'agentChat.tool.label.stopped',
    'Read': 'agentChat.tool.label.read',
    'Listed': 'agentChat.tool.label.listed',
    'Listed files': 'agentChat.tool.label.listedFiles',
    'Edited': 'agentChat.tool.label.edited',
    'Created': 'agentChat.tool.label.created',
    'Patched': 'agentChat.tool.label.patched',
    'Wrote': 'agentChat.tool.label.wrote',
    'Searched': 'agentChat.tool.label.searched',
    'Found files': 'agentChat.tool.label.foundFiles',
    'Looked up tools': 'agentChat.tool.label.lookedUpTools',
    'Fetched': 'agentChat.tool.label.fetched',
    'Searched the web': 'agentChat.tool.label.searchedWeb',
    'Ran agent': 'agentChat.tool.label.ranAgent',
    'Started agent': 'agentChat.tool.label.startedAgent',
    'Messaged agent': 'agentChat.tool.label.messagedAgent',
    'Closed agent': 'agentChat.tool.label.closedAgent',
    'Stopped agent': 'agentChat.tool.label.stoppedAgent',
    'Waited for agents': 'agentChat.tool.label.waitedForAgents',
    'Waited for': 'agentChat.tool.label.waitedFor',
    'Agent finished': 'agentChat.tool.label.agentFinished',
    'Updated plan': 'agentChat.tool.label.updatedPlan',
    'Proposed plan': 'agentChat.tool.label.proposedPlan',
    'Used skill': 'agentChat.tool.label.usedSkill',
    'Ran tests': 'agentChat.tool.label.ranTests',
    'Committed': 'agentChat.tool.label.committed',
    'Committed and pushed': 'agentChat.tool.label.committedAndPushed',
    'Pushed': 'agentChat.tool.label.pushed',
    'Checked PR': 'agentChat.tool.label.checkedPullRequest',
    'Closed PR': 'agentChat.tool.label.closedPullRequest',
    'Commented on PR': 'agentChat.tool.label.commentedPullRequest',
    'Opened PR': 'agentChat.tool.label.openedPullRequest',
    'Updated PR': 'agentChat.tool.label.updatedPullRequest',
    'Merged PR': 'agentChat.tool.label.mergedPullRequest',
    'Listed PRs': 'agentChat.tool.label.listedPullRequests',
    'Viewed issue': 'agentChat.tool.label.viewedIssue',
    'Listed issues': 'agentChat.tool.label.listedIssues',
    'Opened issue': 'agentChat.tool.label.openedIssue',
    'Updated issue': 'agentChat.tool.label.updatedIssue',
    'Commented on issue': 'agentChat.tool.label.commentedIssue',
    'Closed issue': 'agentChat.tool.label.closedIssue',
    'Reopened issue': 'agentChat.tool.label.reopenedIssue',
    'Checked CI run': 'agentChat.tool.label.checkedCiRun',
    'Read CI logs': 'agentChat.tool.label.readCiLogs',
    'Listed CI runs': 'agentChat.tool.label.listedCiRuns',
    'Reran CI': 'agentChat.tool.label.reranCi',
    'Canceled CI run': 'agentChat.tool.label.canceledCiRun',
    'Started workflow': 'agentChat.tool.label.startedWorkflow',
    'Called GitHub API': 'agentChat.tool.label.calledGitHubApi',
    'Inspected deployment': 'agentChat.tool.label.inspectedDeployment',
    'Read deployment logs': 'agentChat.tool.label.readDeploymentLogs',
    'Listed deployments': 'agentChat.tool.label.listedDeployments',
    'Listed env vars': 'agentChat.tool.label.listedEnvVars',
    'Pulled env vars': 'agentChat.tool.label.pulledEnvVars',
    'Redeployed': 'agentChat.tool.label.redeployed',
    'Deployed': 'agentChat.tool.label.deployed',
    'Promoted deployment': 'agentChat.tool.label.promotedDeployment',
    'Checked acceptance setup': 'agentChat.tool.label.checkedAcceptanceSetup',
    'Viewed acceptance': 'agentChat.tool.label.viewedAcceptance',
    'Read acceptance feedback': 'agentChat.tool.label.readAcceptanceFeedback',
    'Listed acceptances': 'agentChat.tool.label.listedAcceptances',
    'Published acceptance': 'agentChat.tool.label.publishedAcceptance',
    'Published acceptance round': 'agentChat.tool.label.publishedAcceptanceRound',
    'Linked PR to acceptance': 'agentChat.tool.label.linkedAcceptancePullRequest',
    'Asked': 'agentChat.tool.label.asked',
    'Viewed image': 'agentChat.tool.label.viewedImage',
    'Thought': 'agentChat.tool.label.thought',
    'Thinking': 'agentChat.tool.label.thinking',
    'Used the browser': 'agentChat.tool.label.usedBrowser',
    'Used Computer Use': 'agentChat.tool.label.usedComputerUse',
};

/**
 * The present tense of each recognized `gh`, `vc`, and `lh` step (`Viewing issue`), because the command kind's own
 * `Running` would read `Running #12` in front of such a step's subject.
 */
export const CLI_ACTIVE_LABEL_KEYS: Readonly<
    Partial<Record<AgentShellCliLabel, AgentChatLabelKey>>
> = {
    'Viewed issue': 'agentChat.tool.active.cli.viewedIssue',
    'Listed issues': 'agentChat.tool.active.cli.listedIssues',
    'Opened issue': 'agentChat.tool.active.cli.openedIssue',
    'Updated issue': 'agentChat.tool.active.cli.updatedIssue',
    'Commented on issue': 'agentChat.tool.active.cli.commentedIssue',
    'Closed issue': 'agentChat.tool.active.cli.closedIssue',
    'Reopened issue': 'agentChat.tool.active.cli.reopenedIssue',
    'Checked CI run': 'agentChat.tool.active.cli.checkedCiRun',
    'Read CI logs': 'agentChat.tool.active.cli.readCiLogs',
    'Listed CI runs': 'agentChat.tool.active.cli.listedCiRuns',
    'Reran CI': 'agentChat.tool.active.cli.reranCi',
    'Canceled CI run': 'agentChat.tool.active.cli.canceledCiRun',
    'Started workflow': 'agentChat.tool.active.cli.startedWorkflow',
    'Called GitHub API': 'agentChat.tool.active.cli.calledGitHubApi',
    'Inspected deployment': 'agentChat.tool.active.cli.inspectedDeployment',
    'Read deployment logs': 'agentChat.tool.active.cli.readDeploymentLogs',
    'Listed deployments': 'agentChat.tool.active.cli.listedDeployments',
    'Listed env vars': 'agentChat.tool.active.cli.listedEnvVars',
    'Pulled env vars': 'agentChat.tool.active.cli.pulledEnvVars',
    'Redeployed': 'agentChat.tool.active.cli.redeployed',
    'Deployed': 'agentChat.tool.active.cli.deployed',
    'Promoted deployment': 'agentChat.tool.active.cli.promotedDeployment',
    'Checked acceptance setup': 'agentChat.tool.active.cli.checkedAcceptanceSetup',
    'Viewed acceptance': 'agentChat.tool.active.cli.viewedAcceptance',
    'Read acceptance feedback': 'agentChat.tool.active.cli.readAcceptanceFeedback',
    'Listed acceptances': 'agentChat.tool.active.cli.listedAcceptances',
    'Published acceptance': 'agentChat.tool.active.cli.publishedAcceptance',
    'Published acceptance round': 'agentChat.tool.active.cli.publishedAcceptanceRound',
    'Linked PR to acceptance': 'agentChat.tool.active.cli.linkedAcceptancePullRequest',
};

/**
 * A tool presentation's past-tense label (`Edited`) in the reader's language. A label the table does not know, or one
 * already translated, is returned unchanged, so applying this twice is harmless.
 */
export function agentToolLabel(
    label: string,
    t: AgentChatLabelTranslate = translateAgentChatLabel,
): string {
    const key = Object.hasOwn(TOOL_LABEL_KEYS, label) ? TOOL_LABEL_KEYS[label] : undefined;
    return key ? t(key) : label;
}
