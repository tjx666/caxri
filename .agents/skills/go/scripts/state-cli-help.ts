import { ciFailureKindSchema } from './ci-fallback';
import { materialDriftKindSchema, nonMaterialDriftKindSchema } from './issue-drift';
import { mutationLeaseKindSchema } from './mutation-lease';
import { resourceCleanupKindSchema } from './resource-cleanup';
import { reviewModeSchema, reviewPolicyModeSchema } from './review-gate';
import {
    acceptanceStatusSchema,
    issueStatusSchema,
    noteKindSchema,
    phaseSchema,
    pullRequestStatusSchema,
} from './state-model';
import { validationKindSchema } from './validation-gate';

const COMMAND_USAGE: Record<string, string> = {
    'acceptance':
        'acceptance --state PATH [--status STATUS] [--id ID] [--url URL] [--accepted-head-sha SHA] [--waived-head-sha SHA --waiver-reason TEXT]',
    'acceptance-orphan':
        'acceptance-orphan --state PATH --acceptance-id ID --reason TEXT [--verify-run-id ID]',
    'acceptance-reconcile-round': 'acceptance-reconcile-round --state PATH --round N --reason TEXT',
    'acceptance-restart-lineage':
        'acceptance-restart-lineage --state PATH --acceptance-id ID --reason TEXT',
    'acceptance-publish': 'acceptance-publish --state PATH --report-dir DIR --head-sha SHA',
    'checkpoint':
        'checkpoint --state PATH [--boundary manual|issue|batch|phase] [--issue-number N] [--tokens N|unavailable] [--commit-count N|unavailable] [--file-count N|unavailable] [--revised-eta TEXT]',
    'ci-fallback-admit':
        'ci-fallback-admit --state PATH --failure-kind KIND --failure-detail TEXT --failure-job NAME --failure-url URL --head-sha SHA [--verified-zero-steps] [--authorization TEXT]',
    'ci-fallback-result':
        'ci-fallback-result --state PATH --head-sha SHA --platform-command COMMAND --platform-result RESULT --e2e-command COMMAND --e2e-result RESULT',
    'drift-assess':
        'drift-assess --state PATH --number N --head-sha SHA --kind KIND --drift-key KEY [--expectation TEXT --evidence TEXT --decision TEXT --acceptance-impact TEXT] [--decision-required]',
    'drift-comment': 'drift-comment --state PATH --number N --record-id ID',
    'finalization-delivered': 'finalization-delivered --state PATH',
    'finalization-generate':
        'finalization-generate --state PATH --head-sha SHA --merge-sha SHA --issue NUMBER:CLOSED:Done',
    'init': 'init --objective TEXT [--run-id ID] [--branch NAME] [--worktree-path PATH --main-checkout-path PATH --base-sha SHA]',
    'issue':
        'issue --state PATH --number N [--title TEXT] [--status STATUS] [--check ID] [--commit SHA] [--dependency N] [--priority TEXT] [--validation ID]',
    'mutation-acquire': 'mutation-acquire --state PATH --kind repair --holder-id ID',
    'mutation-release': 'mutation-release --state PATH --kind repair --holder-id ID',
    'note': 'note --state PATH --kind KIND --text TEXT',
    'notes': 'notes --state PATH [--json]',
    'phase': 'phase --state PATH --phase NAME [--reason TEXT]',
    'pr': 'pr --state PATH [--number N] [--url URL] [--status STATUS] [--head-sha SHA] [--branch NAME]',
    'report-delivered': 'report-delivered --state PATH --head-sha SHA [--acceptance-url URL]',
    'report-generate': 'report-generate --state PATH --head-sha SHA',
    'resource-audit': 'resource-audit --state PATH [--recovered KIND]',
    'resume': 'resume --state PATH [--json]',
    'review':
        'review --state PATH --head-sha SHA --mode full|quick|light --p0 N --p1 N --scope TEXT --reviewed-range RANGE [--baseline-review-id ID] [--baseline-head-sha SHA] [--parent-review-id ID] [--freeze]',
    'review-reconcile-head': 'review-reconcile-head --state PATH --review-id ID --reason TEXT',
    'review-policy': 'review-policy --state PATH --mode full-once|quick|light --source TEXT',
    'scope-admit': 'scope-admit --state PATH --title TEXT [--blocking]',
    'show': 'show --state PATH',
    'validate': 'validate --state PATH',
    'validation-run':
        'validation-run --state PATH --kind KIND --lineage-id ID [--head-sha EXPECTED_SHA] [--session-id ID] -- EXECUTABLE [ARG ...]',
    'worktree':
        'worktree --state PATH --worktree-path PATH --main-checkout-path PATH --base-sha SHA [--branch NAME]',
};

const COMMAND_VALUES: Partial<Record<string, string[]>> = {
    'acceptance': [`status: ${acceptanceStatusSchema.options.join('|')}`],
    'ci-fallback-admit': [`failure-kind: ${ciFailureKindSchema.options.join('|')}`],
    'drift-assess': [
        `kind: ${[...materialDriftKindSchema.options, ...nonMaterialDriftKindSchema.options].join('|')}`,
    ],
    'issue': [`status: ${issueStatusSchema.options.join('|')}`],
    'mutation-acquire': [`kind: ${mutationLeaseKindSchema.options.join('|')}`],
    'mutation-release': [`kind: ${mutationLeaseKindSchema.options.join('|')}`],
    'note': [`kind: ${noteKindSchema.options.join('|')}`],
    'phase': [`phase: ${phaseSchema.options.join('|')}`],
    'pr': [`status: ${pullRequestStatusSchema.options.join('|')}`],
    'review': [`mode: ${reviewModeSchema.options.join('|')}`],
    'review-policy': [`mode: ${reviewPolicyModeSchema.options.join('|')}`],
    'resource-audit': [`recovered: ${resourceCleanupKindSchema.options.join('|')}`],
    'validation-run': [`kind: ${validationKindSchema.options.join('|')}`],
};

export function stateCliHelp(command?: string): string {
    if (!command) {
        return `Go run-state ledger

Usage:
  bun run .agents/skills/go/scripts/state.ts help <command>

Commands:
${Object.keys(COMMAND_USAGE)
    .toSorted((a, b) => a.localeCompare(b))
    .map((name) => `  ${name}`)
    .join('\n')}`;
    }
    const usage = COMMAND_USAGE[command];
    if (!usage) throw new Error(`Unknown Go state command: ${command}`);
    const values = COMMAND_VALUES[command];
    return `Go run-state ledger

Usage:
  bun run .agents/skills/go/scripts/state.ts ${usage}${values ? `\n\nAllowed values:\n${values.map((value) => `  ${value}`).join('\n')}` : ''}`;
}
