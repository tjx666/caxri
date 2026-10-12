import { MAX_IGNORED_CHECKS, normalizeIgnoredCheckRule } from '@caxri/protocol';

import { useTranslation } from '../../i18n';
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
    const { t } = useTranslation();
    return (
        <RuleListForm
            ariaLabel={t('settings.ignoredChecksForm.ariaLabel')}
            description={t('settings.ignoredChecksForm.description')}
            placeholder="codecov/*"
            inputLabel={t('settings.ignoredChecksForm.inputLabel')}
            listLabel={t('settings.ignoredChecksForm.listLabel')}
            emptyText={t('settings.ignoredChecksForm.empty')}
            normalize={normalizeIgnoredCheckRule}
            invalidMessage={t('settings.ignoredChecksForm.invalid')}
            duplicateMessage={t('settings.ignoredChecksForm.duplicate')}
            maximum={MAX_IGNORED_CHECKS}
            maximumMessage={t('settings.ignoredChecksForm.maximum', {
                maximum: MAX_IGNORED_CHECKS,
            })}
            removeLabel={(rule) => t('settings.ignoredChecksForm.remove', { rule })}
            rules={rules}
            onChange={onChange}
        />
    );
}
