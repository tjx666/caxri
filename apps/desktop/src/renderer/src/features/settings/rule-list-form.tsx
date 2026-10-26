import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';

import { Trash2 } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { useTranslation } from '../../i18n';
import { isImeComposing } from '../../lib/ime';

export interface RuleListFormProperties {
    /**
     * Accessible name for the editor `<section>`.
     */
    ariaLabel: string;
    description: ReactNode;
    placeholder: string;
    /**
     * Accessible name for the draft input.
     */
    inputLabel: string;
    /**
     * Accessible name for the rendered rule list.
     */
    listLabel: string;
    /**
     * Copy shown in place of the list when no rule has been added yet.
     */
    emptyText: string;
    /**
     * Canonicalizes one draft entry, or returns `undefined` when it does not parse as a valid rule.
     */
    normalize: (draft: string) => string | undefined;
    invalidMessage: string;
    duplicateMessage: string;
    maximum: number;
    maximumMessage: string;
    /**
     * Accessible name for a rule's remove button.
     */
    removeLabel: (rule: string) => string;
    rules: string[];
    onChange: (rules: string[]) => void;
    /**
     * Bumped by the caller to scroll the draft input into view and focus it, e.g. from a command-triggered Settings
     * deep link. Omit when the row has no such entry point.
     */
    focusRequestId?: number;
}

/**
 * Generic list editor shared by Settings rows that persist a deduplicated, capped list of normalized string rules
 * (trusted domains, trusted folders, …): a draft input with Add, validation feedback, and a removable row per rule.
 */
export function RuleListForm({
    ariaLabel,
    description,
    placeholder,
    inputLabel,
    listLabel,
    emptyText,
    normalize,
    invalidMessage,
    duplicateMessage,
    maximum,
    maximumMessage,
    removeLabel,
    focusRequestId = 0,
    rules,
    onChange,
}: RuleListFormProperties) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState('');
    const [error, setError] = useState<string>();
    const inputReference = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!focusRequestId) return;
        inputReference.current?.scrollIntoView({ block: 'center' });
        inputReference.current?.focus();
    }, [focusRequestId]);

    const add = (): void => {
        const rule = normalize(draft);
        if (!rule) {
            setError(invalidMessage);
            return;
        }
        if (rules.includes(rule)) {
            setError(duplicateMessage);
            return;
        }
        if (rules.length >= maximum) {
            setError(maximumMessage);
            return;
        }
        onChange([...rules, rule]);
        setDraft('');
        setError(undefined);
    };

    return (
        <section aria-label={ariaLabel}>
            <p className="m-0 text-[11px] text-muted">{description}</p>
            <div className="mt-2 flex gap-2">
                <Input
                    ref={inputReference}
                    aria-label={inputLabel}
                    aria-invalid={Boolean(error)}
                    className="min-w-0 flex-1"
                    placeholder={placeholder}
                    value={draft}
                    onChange={(event) => {
                        setDraft(event.target.value);
                        setError(undefined);
                    }}
                    onKeyDown={(event) => {
                        if (isImeComposing(event) || event.key !== 'Enter') return;
                        event.preventDefault();
                        add();
                    }}
                />
                <Button disabled={!draft.trim()} size="sm" variant="secondary" onClick={add}>
                    {t('common.add')}
                </Button>
            </div>
            {error && (
                <p className="mt-2 text-[11px] text-danger" role="alert">
                    {error}
                </p>
            )}
            {rules.length > 0 ? (
                <ul className="mt-3 space-y-1" aria-label={listLabel}>
                    {rules.map((rule) => (
                        <li
                            key={rule}
                            className="flex min-h-8 items-center gap-2 rounded border border-border bg-elevated px-2"
                        >
                            <code className="min-w-0 flex-1 truncate text-[11px]">{rule}</code>
                            <Button
                                aria-label={removeLabel(rule)}
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
                <p className="mt-3 text-[11px] text-muted">{emptyText}</p>
            )}
        </section>
    );
}
