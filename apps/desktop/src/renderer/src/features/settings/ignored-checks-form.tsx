import { MAX_IGNORED_CHECKS, normalizeIgnoredCheckRule } from '@caxri/protocol';

import { RuleListForm } from './rule-list-form';

interface IgnoredChecksFormProperties {
    rules: string[];
    onChange: (rules: string[]) => void;
}

/**
 * Structured Settings editor for the CI checks Project Status ignores. A rule matches a check's job name, its status
 * context, or its workflow name, so one workflow-wide pattern can silence every job that workflow owns.
 */
export function IgnoredChecksForm({ rules, onChange }: IgnoredChecksFormProperties) {
    return (
        <RuleListForm
            ariaLabel="Ignored checks editor"
            description="Each pattern is matched against the check's job name, its status context, and its workflow name. Matching is case-insensitive; * and ? are wildcards."
            placeholder="codecov/*"
            inputLabel="Ignored check rule"
            listLabel="Ignored check rules"
            emptyText="No ignored checks."
            normalize={normalizeIgnoredCheckRule}
            invalidMessage="Enter a check name or glob pattern."
            duplicateMessage="This check is already ignored."
            maximum={MAX_IGNORED_CHECKS}
            maximumMessage={`Ignored checks supports at most ${MAX_IGNORED_CHECKS} rules.`}
            removeLabel={(rule) => `Remove ignored check ${rule}`}
            rules={rules}
            onChange={onChange}
        />
    );
}
