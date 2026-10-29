import { useState } from 'react';

import type { AgentSecretScope, AgentSecretSummary, ProjectRecord } from '@caxri/protocol';
import { KeyRound, Plus, Trash2 } from 'lucide-react';

import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '../../../components/ui/select';
import { Spinner } from '../../../components/ui/spinner';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { caxri } from '../../../lib/caxri';
import { useCaxriQuery } from '../../../queries/client';
import { useProjects, useSelectedProject } from '../../../stores/selectors';
import { tryCommand } from '../../../stores/toasts';
import { deleteAgentSecret, saveAgentSecret } from '../../agent-secrets/agent-secrets-client';
import {
    defaultSecretScope,
    GLOBAL_SCOPE_VALUE,
    isValidSecretName,
    scopeFromValue,
    scopeValue,
    secretScopeProjects,
    sortSecrets,
} from '../../agent-secrets/agent-secrets-summary';

interface SecretDraft {
    /**
     * Set when replacing an existing secret's value: its name and scope are fixed.
     */
    replacing?: AgentSecretSummary;
    name: string;
    scope: AgentSecretScope;
    value: string;
}

/**
 * The user's Agent secrets. Values are write-only: the list shows names and scopes, and a value can only be replaced,
 * never read back, so Settings never puts a secret on screen.
 */
export function AgentSecretsForm() {
    const { t } = useTranslation();
    const query = useCaxriQuery('secrets.list', {});
    const projects = secretScopeProjects(useProjects());
    const selectedProject = useSelectedProject();
    const [draft, setDraft] = useState<SecretDraft | undefined>();

    if (!query.data && query.isError)
        return (
            <div className="grid min-h-16 content-center justify-items-start gap-2" role="alert">
                <p className="m-0 text-[12px] text-danger">
                    {t('agentSecrets.settings.loadFailed')}
                </p>
                <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                        void query.refetch();
                    }}
                >
                    {t('common.retry')}
                </Button>
            </div>
        );
    if (!query.data)
        return (
            <div className="flex min-h-16 items-center gap-2 text-[12px] text-muted" role="status">
                <Spinner aria-hidden="true" size={13} style={{ width: 13, height: 13 }} />
                {t('agentSecrets.settings.loading')}
            </div>
        );

    const projectTitle = (projectId: string) =>
        projects.find((project) => project.id === projectId)?.title;
    const scopeLabel = (scope: AgentSecretScope) =>
        scope.kind === 'global'
            ? t('agentSecrets.settings.scopeGlobal')
            : (projectTitle(scope.projectId) ?? t('agentSecrets.settings.missingProject'));
    const secrets = sortSecrets(query.data.secrets, projectTitle);
    const remove = async (secret: AgentSecretSummary) => {
        const isConfirmed = await caxri.window.showConfirm({
            title: t('agentSecrets.settings.deleteTitle', { name: secret.name }),
            message: t('agentSecrets.settings.deleteMessage', { scope: scopeLabel(secret.scope) }),
            confirmLabel: t('agentSecrets.settings.deleteConfirm'),
        });
        if (!isConfirmed) return;
        await tryCommand(t('agentSecrets.settings.deleteConfirm'), () =>
            deleteAgentSecret({ name: secret.name, scope: secret.scope }),
        );
    };

    return (
        <div className="grid w-full grid-cols-1 gap-2" data-testid="agent-secrets-form">
            {secrets.length === 0 && !draft && (
                <p className="m-0 text-[12px] text-muted">{t('agentSecrets.settings.empty')}</p>
            )}
            {secrets.length > 0 && (
                <ul className="m-0 grid list-none divide-y divide-border rounded-md border border-border p-0">
                    {secrets.map((secret) => (
                        <li
                            key={`${scopeValue(secret.scope)}:${secret.name}`}
                            className="flex items-center gap-3 px-3 py-2"
                        >
                            <KeyRound aria-hidden="true" className="size-3.5 shrink-0 text-muted" />
                            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground">
                                {secret.name}
                            </span>
                            <span className="shrink-0 truncate text-[12px] text-muted">
                                {scopeLabel(secret.scope)}
                            </span>
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                    setDraft({
                                        replacing: secret,
                                        name: secret.name,
                                        scope: secret.scope,
                                        value: '',
                                    })
                                }
                            >
                                {t('agentSecrets.settings.replace')}
                            </Button>
                            <Tooltip
                                content={t('agentSecrets.settings.delete', { name: secret.name })}
                            >
                                <Button
                                    aria-label={t('agentSecrets.settings.delete', {
                                        name: secret.name,
                                    })}
                                    size="icon"
                                    variant="ghost"
                                    onClick={() => {
                                        void remove(secret);
                                    }}
                                >
                                    <Trash2 className="size-3.5" />
                                </Button>
                            </Tooltip>
                        </li>
                    ))}
                </ul>
            )}
            {draft ? (
                <SecretEditor
                    key={draft.replacing ? scopeValue(draft.replacing.scope) + draft.name : 'new'}
                    draft={draft}
                    projects={projects}
                    onCancel={() => setDraft(undefined)}
                    onChange={setDraft}
                    onSaved={() => setDraft(undefined)}
                />
            ) : (
                <Button
                    className="justify-self-start"
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                        setDraft({
                            name: '',
                            scope: defaultSecretScope(selectedProject),
                            value: '',
                        })
                    }
                >
                    <Plus className="size-3.5" />
                    {t('agentSecrets.settings.add')}
                </Button>
            )}
        </div>
    );
}

function SecretEditor({
    draft,
    projects,
    onCancel,
    onChange,
    onSaved,
}: {
    draft: SecretDraft;
    projects: readonly ProjectRecord[];
    onCancel: () => void;
    onChange: (draft: SecretDraft) => void;
    onSaved: () => void;
}) {
    const { t } = useTranslation();
    const [isSaving, setIsSaving] = useState(false);
    const [hasSaveFailed, setHasSaveFailed] = useState(false);
    const isNameValid = isValidSecretName(draft.name);
    const canSave = isNameValid && draft.value.length > 0 && !isSaving;
    const save = async () => {
        if (!canSave) return;
        setIsSaving(true);
        setHasSaveFailed(false);
        try {
            await saveAgentSecret({ name: draft.name, scope: draft.scope, value: draft.value });
            onSaved();
        } catch {
            setHasSaveFailed(true);
            setIsSaving(false);
        }
    };
    return (
        <form
            className="grid gap-3 rounded-md border border-border bg-elevated p-3"
            onSubmit={(event) => {
                event.preventDefault();
                void save();
            }}
        >
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
                <label className="grid gap-1">
                    <span className="text-[12px] text-foreground">
                        {t('agentSecrets.settings.name')}
                    </span>
                    <Input
                        autoFocus={!draft.replacing}
                        aria-invalid={draft.name.length > 0 && !isNameValid}
                        autoComplete="off"
                        className="bg-background font-mono"
                        disabled={Boolean(draft.replacing)}
                        placeholder={t('agentSecrets.settings.namePlaceholder')}
                        spellCheck={false}
                        value={draft.name}
                        onChange={(event) => onChange({ ...draft, name: event.target.value })}
                    />
                </label>
                <label className="grid gap-1">
                    <span className="text-[12px] text-foreground">
                        {t('agentSecrets.settings.scope')}
                    </span>
                    <Select
                        disabled={Boolean(draft.replacing)}
                        value={scopeValue(draft.scope)}
                        onValueChange={(value) => {
                            if (value !== null)
                                onChange({ ...draft, scope: scopeFromValue(value) });
                        }}
                    >
                        <SelectTrigger className="bg-background">
                            <SelectValue>
                                {(value: string) =>
                                    value === GLOBAL_SCOPE_VALUE
                                        ? t('agentSecrets.settings.scopeGlobal')
                                        : (projects.find((project) => project.id === value)
                                              ?.title ?? t('agentSecrets.settings.missingProject'))
                                }
                            </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value={GLOBAL_SCOPE_VALUE}>
                                {t('agentSecrets.settings.scopeGlobal')}
                            </SelectItem>
                            {projects.map((project) => (
                                <SelectItem key={project.id} value={project.id}>
                                    {project.title}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </label>
            </div>
            {draft.name.length > 0 && !isNameValid && (
                <p className="m-0 text-[11px] text-danger" role="alert">
                    {t('agentSecrets.settings.invalidName')}
                </p>
            )}
            <label className="grid gap-1">
                <span className="text-[12px] text-foreground">
                    {t('agentSecrets.settings.value')}
                </span>
                {/* `data-1p-ignore` and `data-lpignore` keep password managers from offering to fill or save it. */}
                <Input
                    autoFocus={Boolean(draft.replacing)}
                    autoComplete="off"
                    className="bg-background font-mono"
                    data-1p-ignore
                    data-lpignore="true"
                    spellCheck={false}
                    type="password"
                    value={draft.value}
                    onChange={(event) => onChange({ ...draft, value: event.target.value })}
                />
            </label>
            {hasSaveFailed && (
                <p className="m-0 text-[11px] text-danger" role="alert">
                    {t('agentSecrets.settings.saveFailed')}
                </p>
            )}
            <div className="flex justify-end gap-2">
                <Button size="sm" type="button" variant="secondary" onClick={onCancel}>
                    {t('agentSecrets.settings.cancel')}
                </Button>
                <Button disabled={!canSave} size="sm" type="submit">
                    {isSaving && <Spinner />}
                    {t('agentSecrets.settings.save')}
                </Button>
            </div>
        </form>
    );
}
