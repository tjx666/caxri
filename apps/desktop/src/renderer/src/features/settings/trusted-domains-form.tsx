import { MAX_TRUSTED_DOMAINS, normalizeTrustedDomainRule } from '@caxri/protocol';

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
    return (
        <RuleListForm
            ariaLabel="Trusted Domains editor"
            description={
                <>
                    Exact origins match one scheme and port. Use an explicit{' '}
                    <code>*.example.com</code> rule for that domain and its subdomains. Loopback
                    hosts are trusted by default.
                </>
            }
            placeholder="https://example.com"
            inputLabel="Trusted domain rule"
            listLabel="Trusted domain rules"
            emptyText="No user-defined trusted domains."
            normalize={normalizeTrustedDomainRule}
            invalidMessage="Enter an HTTP(S) origin or an explicit https://*.example.com rule."
            duplicateMessage="This domain is already trusted."
            maximum={MAX_TRUSTED_DOMAINS}
            maximumMessage={`Trusted Domains supports at most ${MAX_TRUSTED_DOMAINS} rules.`}
            removeLabel={(rule) => `Remove trusted domain ${rule}`}
            focusRequestId={focusRequestId}
            rules={rules}
            onChange={onChange}
        />
    );
}
