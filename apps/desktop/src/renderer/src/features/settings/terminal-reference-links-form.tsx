import { useId, useState } from 'react';

import type { TerminalReferenceLinkRule } from '@caxri/protocol';
import {
    MAX_TERMINAL_REFERENCE_LINKS,
    terminalReferenceLinkRuleSchema,
    terminalReferenceLinksSchema,
} from '@caxri/protocol';
import { Pencil, Trash2 } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Switch } from '../../components/ui/switch';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';

interface TerminalReferenceLinksFormProperties {
    rules: TerminalReferenceLinkRule[];
    onChange: (rules: TerminalReferenceLinkRule[]) => void;
}

interface ReferenceRuleDraft {
    alphanumeric: boolean;
    ignoreCase: boolean;
    prefix: string;
    title: string;
    url: string;
}

const emptyDraft: ReferenceRuleDraft = {
    alphanumeric: false,
    ignoreCase: false,
    prefix: '',
    title: '',
    url: '',
};

/**
 * Structured editor for URL-only Terminal autolinks. Drafts stay local until the complete rule passes the shared
 * protocol schema, so an unfinished URL never replaces the last valid persisted Settings value.
 */
export function TerminalReferenceLinksForm({
    rules,
    onChange,
}: TerminalReferenceLinksFormProperties) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState<ReferenceRuleDraft>(emptyDraft);
    const [editingIndex, setEditingIndex] = useState<number>();
    const [error, setError] = useState<string>();
    const id = useId();

    const resetDraft = (): void => {
        setDraft(emptyDraft);
        setEditingIndex(undefined);
        setError(undefined);
    };

    const save = (): void => {
        const parsed = terminalReferenceLinkRuleSchema.safeParse({
            ...draft,
            prefix: draft.prefix.trim(),
            title: draft.title.trim() || null,
            url: draft.url.trim(),
        });
        if (!parsed.success) {
            setError(
                parsed.error.issues[0]?.message ?? t('settings.referenceLinksForm.invalidRule'),
            );
            return;
        }
        const next = [...rules];
        if (editingIndex === undefined) next.push(parsed.data);
        else next[editingIndex] = parsed.data;
        const validated = terminalReferenceLinksSchema.safeParse(next);
        if (!validated.success) {
            setError(
                validated.error.issues[0]?.message ?? t('settings.referenceLinksForm.overlap'),
            );
            return;
        }
        onChange(validated.data);
        resetDraft();
    };

    const edit = (index: number): void => {
        const rule = rules[index];
        setDraft({ ...rule, title: rule.title ?? '' });
        setEditingIndex(index);
        setError(undefined);
    };

    const remove = (index: number): void => {
        onChange(rules.filter((_, candidate) => candidate !== index));
        if (editingIndex === index) resetDraft();
        else if (editingIndex !== undefined && editingIndex > index)
            setEditingIndex(editingIndex - 1);
    };

    return (
        <section aria-label={t('settings.referenceLinksForm.ariaLabel')}>
            <p className="m-0 text-[11px] text-muted">
                {t('settings.referenceLinksForm.descriptionBeforeToken')}
                <code>&lt;num&gt;</code>
                {t('settings.referenceLinksForm.descriptionAfterToken')}
            </p>
            {rules.length > 0 ? (
                <ul
                    className="mt-3 space-y-1"
                    aria-label={t('settings.referenceLinksForm.listLabel')}
                >
                    {rules.map((rule, index) => (
                        <li
                            className="flex min-w-0 items-center gap-2 rounded border border-border bg-elevated px-2 py-1.5 text-[11px]"
                            key={`${rule.prefix}:${rule.url}`}
                        >
                            <code className="shrink-0 text-foreground">{rule.prefix}</code>
                            <span className="min-w-0 flex-1 truncate text-muted">
                                {rule.title ?? t('settings.referenceLinksForm.externalReference')} ·{' '}
                                {rule.url}
                            </span>
                            <Tooltip
                                content={t('settings.referenceLinksForm.edit', {
                                    prefix: rule.prefix,
                                })}
                            >
                                <Button
                                    aria-label={t('settings.referenceLinksForm.edit', {
                                        prefix: rule.prefix,
                                    })}
                                    className="size-6 min-h-0 p-0"
                                    size="icon"
                                    variant="ghost"
                                    onClick={() => edit(index)}
                                >
                                    <Pencil size={12} />
                                </Button>
                            </Tooltip>
                            <Tooltip
                                content={t('settings.referenceLinksForm.delete', {
                                    prefix: rule.prefix,
                                })}
                            >
                                <Button
                                    aria-label={t('settings.referenceLinksForm.delete', {
                                        prefix: rule.prefix,
                                    })}
                                    className="size-6 min-h-0 p-0 text-muted hover:text-danger"
                                    size="icon"
                                    variant="ghost"
                                    onClick={() => remove(index)}
                                >
                                    <Trash2 size={12} />
                                </Button>
                            </Tooltip>
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="mt-3 text-[11px] text-muted">
                    {t('settings.referenceLinksForm.empty')}
                </p>
            )}
            <div className="mt-3 grid grid-cols-[minmax(8rem,0.8fr)_minmax(8rem,0.8fr)_minmax(14rem,2fr)] gap-2">
                <Input
                    aria-label={t('settings.referenceLinksForm.titleLabel')}
                    className="bg-elevated"
                    placeholder={t('settings.referenceLinksForm.titlePlaceholder')}
                    value={draft.title}
                    onChange={(event) => {
                        setDraft((current) => ({ ...current, title: event.target.value }));
                        setError(undefined);
                    }}
                />
                <Input
                    aria-label={t('settings.referenceLinksForm.prefixLabel')}
                    className="bg-elevated font-mono"
                    placeholder="TASK-"
                    value={draft.prefix}
                    onChange={(event) => {
                        setDraft((current) => ({ ...current, prefix: event.target.value }));
                        setError(undefined);
                    }}
                />
                <Input
                    aria-label={t('settings.referenceLinksForm.urlLabel')}
                    className="bg-elevated font-mono"
                    placeholder="https://linear.app/workspace/issue/<num>"
                    value={draft.url}
                    onChange={(event) => {
                        setDraft((current) => ({ ...current, url: event.target.value }));
                        setError(undefined);
                    }}
                    onKeyDown={(event) => {
                        if (event.key !== 'Enter') return;
                        event.preventDefault();
                        save();
                    }}
                />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-4">
                <label className="flex cursor-pointer items-center gap-2 text-[11px] text-muted">
                    <Switch
                        id={`${id}-alphanumeric`}
                        checked={draft.alphanumeric}
                        onCheckedChange={(checked) =>
                            setDraft((current) => ({ ...current, alphanumeric: checked }))
                        }
                    />
                    {t('settings.referenceLinksForm.allowLetters')}
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-[11px] text-muted">
                    <Switch
                        id={`${id}-ignore-case`}
                        checked={draft.ignoreCase}
                        onCheckedChange={(checked) =>
                            setDraft((current) => ({ ...current, ignoreCase: checked }))
                        }
                    />
                    {t('settings.referenceLinksForm.ignoreCase')}
                </label>
                <span className="ml-auto flex gap-2">
                    {editingIndex !== undefined && (
                        <Button size="sm" variant="ghost" onClick={resetDraft}>
                            {t('common.cancel')}
                        </Button>
                    )}
                    <Button
                        disabled={
                            !draft.prefix.trim() ||
                            !draft.url.trim() ||
                            (editingIndex === undefined &&
                                rules.length >= MAX_TERMINAL_REFERENCE_LINKS)
                        }
                        size="sm"
                        variant="secondary"
                        onClick={save}
                    >
                        {t(editingIndex === undefined ? 'common.add' : 'common.save')}
                    </Button>
                </span>
            </div>
            {error && (
                <p className="mt-2 text-[11px] text-danger" role="alert">
                    {error}
                </p>
            )}
        </section>
    );
}
