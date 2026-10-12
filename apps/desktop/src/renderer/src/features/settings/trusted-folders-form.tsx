import { MAX_TRUSTED_FOLDERS, normalizeTrustedFolderRule } from '@caxri/protocol';

import { useTranslation } from '../../i18n';
import { RuleListForm } from './rule-list-form';

interface TrustedFoldersFormProperties {
    rules: string[];
    onChange: (rules: string[]) => void;
}

/**
 * Structured Settings editor for absolute folder paths trusted for read-only Terminal file link opens.
 */
export function TrustedFoldersForm({ rules, onChange }: TrustedFoldersFormProperties) {
    const { t } = useTranslation();
    return (
        <RuleListForm
            ariaLabel={t('settings.trustedFoldersForm.ariaLabel')}
            // The row above already says what trusting a folder does; repeating it here left the same sentence printed
            // twice on one screen. This line carries only what the row cannot: the shape of an entry.
            description={t('settings.trustedFoldersForm.description')}
            placeholder="/Users/me/.config"
            inputLabel={t('settings.trustedFoldersForm.inputLabel')}
            listLabel={t('settings.trustedFoldersForm.listLabel')}
            emptyText={t('settings.trustedFoldersForm.empty')}
            normalize={normalizeTrustedFolderRule}
            invalidMessage={t('settings.trustedFoldersForm.invalid')}
            duplicateMessage={t('settings.trustedFoldersForm.duplicate')}
            maximum={MAX_TRUSTED_FOLDERS}
            maximumMessage={t('settings.trustedFoldersForm.maximum', {
                maximum: MAX_TRUSTED_FOLDERS,
            })}
            removeLabel={(rule) => t('settings.trustedFoldersForm.remove', { rule })}
            rules={rules}
            onChange={onChange}
        />
    );
}
