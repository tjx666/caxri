import { MAX_SHELL_COMMAND_PATTERNS, normalizeShellCommandPattern } from '@caxri/protocol';

import { useTranslation } from '../../i18n';
import { RuleListForm } from './rule-list-form';

interface LongRunningCommandsFormProperties {
    rules: string[];
    onChange: (rules: string[]) => void;
}

/**
 * Structured Settings editor for the background commands expected to outlive a turn, such as a development server. A
 * background shell that matches none of them keeps its Session working until it ends.
 */
export function LongRunningCommandsForm({ rules, onChange }: LongRunningCommandsFormProperties) {
    const { t } = useTranslation();
    return (
        <RuleListForm
            ariaLabel={t('settings.longRunningCommandsForm.ariaLabel')}
            description={t('settings.longRunningCommandsForm.description')}
            placeholder="bun run *serve.ts"
            inputLabel={t('settings.longRunningCommandsForm.inputLabel')}
            listLabel={t('settings.longRunningCommandsForm.listLabel')}
            emptyText={t('settings.longRunningCommandsForm.empty')}
            normalize={normalizeShellCommandPattern}
            invalidMessage={t('settings.longRunningCommandsForm.invalid')}
            duplicateMessage={t('settings.longRunningCommandsForm.duplicate')}
            maximum={MAX_SHELL_COMMAND_PATTERNS}
            maximumMessage={t('settings.longRunningCommandsForm.maximum', {
                maximum: MAX_SHELL_COMMAND_PATTERNS,
            })}
            removeLabel={(rule) => t('settings.longRunningCommandsForm.remove', { rule })}
            rules={rules}
            onChange={onChange}
        />
    );
}
