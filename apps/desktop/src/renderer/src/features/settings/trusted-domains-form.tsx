import { MAX_TRUSTED_DOMAINS, normalizeTrustedDomainRule } from '@caxri/protocol';

import { useTranslation } from '../../i18n';
import { RuleListForm } from './rule-list-form';

interface TrustedDomainsFormProperties {
    focusRequestId?: number;
    rules: string[];
    onChange: (rules: string[]) => void;
}

/**
 * Structured Settings editor for exact origins and explicit subdomain wildcard rules.
 */
export function TrustedDomainsForm({
    focusRequestId,
    rules,
    onChange,
}: TrustedDomainsFormProperties) {
    const { t } = useTranslation();
    return (
        <RuleListForm
            ariaLabel={t('settings.trustedDomainsForm.ariaLabel')}
            description={
                <>
                    {t('settings.trustedDomainsForm.descriptionBeforeExample')}
                    <code>*.example.com</code>
                    {t('settings.trustedDomainsForm.descriptionAfterExample')}
                </>
            }
            placeholder="https://example.com"
            inputLabel={t('settings.trustedDomainsForm.inputLabel')}
            listLabel={t('settings.trustedDomainsForm.listLabel')}
            emptyText={t('settings.trustedDomainsForm.empty')}
            normalize={normalizeTrustedDomainRule}
            invalidMessage={t('settings.trustedDomainsForm.invalid')}
            duplicateMessage={t('settings.trustedDomainsForm.duplicate')}
            maximum={MAX_TRUSTED_DOMAINS}
            maximumMessage={t('settings.trustedDomainsForm.maximum', {
                maximum: MAX_TRUSTED_DOMAINS,
            })}
            removeLabel={(rule) => t('settings.trustedDomainsForm.remove', { rule })}
            focusRequestId={focusRequestId}
            rules={rules}
            onChange={onChange}
        />
    );
}
