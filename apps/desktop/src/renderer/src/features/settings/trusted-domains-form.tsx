import { useEffect, useRef, useState } from 'react';

import { MAX_TRUSTED_DOMAINS, normalizeTrustedDomainRule } from '@caxri/protocol';
import { Trash2 } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';

interface TrustedDomainsFormProperties {
    focusRequestId?: number;
    rules: string[];
    onChange: (rules: string[]) => void;
}

/**
 * Structured Settings editor for exact origins and explicit subdomain wildcard rules.
 */
export function TrustedDomainsForm({
    focusRequestId = 0,
    rules,
    onChange,
}: TrustedDomainsFormProperties) {
    const [draft, setDraft] = useState('');
    const [error, setError] = useState<string>();
    const inputReference = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!focusRequestId) return;
        inputReference.current?.scrollIntoView({ block: 'center' });
        inputReference.current?.focus();
    }, [focusRequestId]);

    const add = (): void => {
        const rule = normalizeTrustedDomainRule(draft);
        if (!rule) {
            setError('Enter an HTTP(S) origin or an explicit https://*.example.com rule.');
            return;
        }
        if (rules.includes(rule)) {
            setError('This domain is already trusted.');
            return;
        }
        if (rules.length >= MAX_TRUSTED_DOMAINS) {
            setError(`Trusted Domains supports at most ${MAX_TRUSTED_DOMAINS} rules.`);
            return;
        }
        onChange([...rules, rule]);
        setDraft('');
        setError(undefined);
    };

    return (
        <section aria-label="Trusted Domains editor">
            <p className="m-0 text-[11px] text-muted">
                Exact origins match one scheme and port. Use an explicit <code>*.example.com</code>{' '}
                rule for that domain and its subdomains. Loopback hosts are trusted by default.
            </p>
            <div className="mt-2 flex gap-2">
                <Input
                    ref={inputReference}
                    aria-label="Trusted domain rule"
                    aria-invalid={Boolean(error)}
                    className="min-w-0 flex-1 bg-elevated"
                    placeholder="https://example.com"
                    value={draft}
                    onChange={(event) => {
                        setDraft(event.target.value);
                        setError(undefined);
                    }}
                    onKeyDown={(event) => {
                        if (event.key !== 'Enter') return;
                        event.preventDefault();
                        add();
                    }}
                />
                <Button disabled={!draft.trim()} size="sm" variant="secondary" onClick={add}>
                    Add
                </Button>
            </div>
            {error && (
                <p className="mt-2 text-[11px] text-danger" role="alert">
                    {error}
                </p>
            )}
            {rules.length > 0 ? (
                <ul className="mt-3 space-y-1" aria-label="Trusted domain rules">
                    {rules.map((rule) => (
                        <li
                            key={rule}
                            className="flex min-h-8 items-center gap-2 rounded border border-border bg-elevated px-2"
                        >
                            <code className="min-w-0 flex-1 truncate text-[11px]">{rule}</code>
                            <Button
                                aria-label={`Remove trusted domain ${rule}`}
                                size="icon"
                                variant="ghost"
                                onClick={() => onChange(rules.filter((item) => item !== rule))}
                            >
                                <Trash2 size={13} />
                            </Button>
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="mt-3 text-[11px] text-muted">No user-defined trusted domains.</p>
            )}
        </section>
    );
}
