import { useState } from 'react';

import type { EnvironmentMonitorMihomoSettings } from '@caxri/protocol';
import {
    environmentMonitorMihomoSettingsFileSchema,
    MAX_ENVIRONMENT_MONITOR_ROUTE_ASSERTIONS,
    mihomoControllerAccessSchema,
    normalizeEnvironmentMonitorDomain,
} from '@caxri/protocol';
import { RefreshCw, Trash2 } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { FieldDescription } from '../../components/ui/field';
import { Input } from '../../components/ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '../../components/ui/select';
import { useLatestReference } from '../../hooks/use-latest-reference';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { readMihomoNodes } from '../environment-monitor/environment-monitor-client';

interface EnvironmentMihomoRoutesFormProperties {
    value: EnvironmentMonitorMihomoSettings;
    onChange: (value: EnvironmentMonitorMihomoSettings) => void;
}

interface ControllerDraft {
    canonicalEndpoint: string;
    canonicalSecret: string;
    endpoint: string;
    secret: string;
}

interface ControllerNodeCache {
    accessKey: string;
    expectedNode: string;
    nodes: string[];
}

function controllerAccessKey(endpoint: string, secret: string | null): string {
    return `${endpoint}\0${secret ?? ''}`;
}

function currentControllerDraft(
    draft: ControllerDraft,
    value: EnvironmentMonitorMihomoSettings,
): ControllerDraft {
    const canonicalSecret = value.secret ?? '';
    return draft.canonicalEndpoint === value.endpoint && draft.canonicalSecret === canonicalSecret
        ? draft
        : {
              canonicalEndpoint: value.endpoint,
              canonicalSecret,
              endpoint: value.endpoint,
              secret: canonicalSecret,
          };
}

async function loadControllerNodes(
    access: Parameters<typeof readMihomoNodes>[0],
): Promise<Awaited<ReturnType<typeof readMihomoNodes>> | undefined> {
    try {
        return await readMihomoNodes(access);
    } catch {
        return undefined;
    }
}

export function EnvironmentMihomoRoutesForm({
    value,
    onChange,
}: EnvironmentMihomoRoutesFormProperties) {
    const { t } = useTranslation();
    const latestValue = useLatestReference(value);
    const [controllerDraftState, setControllerDraftState] = useState<ControllerDraft>({
        canonicalEndpoint: value.endpoint,
        canonicalSecret: value.secret ?? '',
        endpoint: value.endpoint,
        secret: value.secret ?? '',
    });
    const controllerDraft = currentControllerDraft(controllerDraftState, value);
    const [nodeCache, setNodeCache] = useState<ControllerNodeCache>({
        accessKey: '',
        expectedNode: '',
        nodes: [],
    });
    const persistedAccessKey = controllerAccessKey(value.endpoint, value.secret);
    const nodes = nodeCache.accessKey === persistedAccessKey ? nodeCache.nodes : [];
    const expectedNode = nodeCache.accessKey === persistedAccessKey ? nodeCache.expectedNode : '';
    const [domain, setDomain] = useState('');
    const [error, setError] = useState<string>();
    const [loading, setLoading] = useState(false);

    const loadNodes = async (): Promise<void> => {
        if (loading) return;
        const parsed = mihomoControllerAccessSchema.safeParse({
            endpoint: controllerDraft.endpoint,
            secret: controllerDraft.secret,
        });
        if (!parsed.success) {
            setError(t('settings.environmentMonitor.mihomo.invalidController'));
            return;
        }
        setLoading(true);
        setError(undefined);
        const result = await loadControllerNodes(parsed.data);
        if (!result) {
            setError(t('settings.environmentMonitor.mihomo.unavailable'));
        } else if (result.nodes.length === 0) {
            setError(t('settings.environmentMonitor.mihomo.noNodes'));
        } else {
            const accessKey = controllerAccessKey(parsed.data.endpoint, parsed.data.secret);
            setNodeCache({
                accessKey,
                expectedNode: result.nodes.includes(expectedNode)
                    ? expectedNode
                    : (result.nodes[0] ?? ''),
                nodes: result.nodes,
            });
            onChange({ ...latestValue.current, ...parsed.data });
        }
        setLoading(false);
    };

    const addAssertion = (): void => {
        const normalizedDomain = normalizeEnvironmentMonitorDomain(domain);
        if (!normalizedDomain) {
            setError(t('settings.environmentMonitor.mihomo.invalidDomain'));
            return;
        }
        if (value.assertions.some((assertion) => assertion.domain === normalizedDomain)) {
            setError(t('settings.environmentMonitor.mihomo.duplicateDomain'));
            return;
        }
        if (!expectedNode) {
            setError(t('settings.environmentMonitor.mihomo.chooseNode'));
            return;
        }
        const parsed = environmentMonitorMihomoSettingsFileSchema.safeParse({
            endpoint: value.endpoint,
            secret: value.secret,
            assertions: [...value.assertions, { domain: normalizedDomain, expectedNode }],
        });
        if (!parsed.success) {
            setError(t('settings.environmentMonitor.mihomo.invalidRule'));
            return;
        }
        onChange(parsed.data);
        setDomain('');
        setError(undefined);
    };

    const updateNode = (index: number, nextNode: string): void => {
        onChange({
            ...value,
            assertions: value.assertions.map((assertion, candidate) =>
                candidate === index ? { ...assertion, expectedNode: nextNode } : assertion,
            ),
        });
    };

    return (
        <section aria-label={t('settings.environmentMonitor.mihomo.ariaLabel')}>
            <div className="grid grid-cols-[minmax(12rem,1.5fr)_minmax(10rem,1fr)_auto] gap-2">
                <Input
                    aria-label={t('settings.environmentMonitor.mihomo.controllerLabel')}
                    disabled={loading}
                    placeholder="http://127.0.0.1:9090"
                    value={controllerDraft.endpoint}
                    onChange={(event) =>
                        setControllerDraftState({
                            ...controllerDraft,
                            endpoint: event.target.value,
                        })
                    }
                />
                <Input
                    aria-label={t('settings.environmentMonitor.mihomo.secretLabel')}
                    autoComplete="off"
                    disabled={loading}
                    placeholder={t('settings.environmentMonitor.mihomo.secretPlaceholder')}
                    type="password"
                    value={controllerDraft.secret}
                    onChange={(event) =>
                        setControllerDraftState({
                            ...controllerDraft,
                            secret: event.target.value,
                        })
                    }
                />
                <Button disabled={loading} size="sm" variant="secondary" onClick={loadNodes}>
                    <RefreshCw
                        aria-hidden="true"
                        className={cn(loading && 'animate-spin motion-reduce:animate-none')}
                        size={13}
                    />
                    {t(
                        loading
                            ? 'settings.environmentMonitor.mihomo.loadingNodes'
                            : 'settings.environmentMonitor.mihomo.loadNodes',
                    )}
                </Button>
            </div>
            <FieldDescription className="mt-1.5">
                {t('settings.environmentMonitor.mihomo.controllerDescription')}
            </FieldDescription>
            {value.assertions.length === 0 ? (
                <FieldDescription className="mt-3">
                    {t('settings.environmentMonitor.mihomo.off')}
                </FieldDescription>
            ) : (
                <ul
                    className="mt-3 space-y-1"
                    aria-label={t('settings.environmentMonitor.mihomo.routesLabel')}
                >
                    {value.assertions.map((assertion, index) => {
                        const availableNodes = nodes.includes(assertion.expectedNode)
                            ? nodes
                            : [assertion.expectedNode, ...nodes];
                        return (
                            <li
                                key={assertion.domain}
                                className="grid grid-cols-[minmax(8rem,1fr)_minmax(10rem,1fr)_auto] items-center gap-2 rounded border border-border bg-elevated px-2 py-1.5"
                            >
                                <code className="min-w-0 truncate text-[11px]">
                                    {assertion.domain}
                                </code>
                                <Select
                                    value={assertion.expectedNode}
                                    onValueChange={(node) => node && updateNode(index, node)}
                                >
                                    <SelectTrigger
                                        aria-label={t(
                                            'settings.environmentMonitor.mihomo.expectedNodeFor',
                                            { domain: assertion.domain },
                                        )}
                                        className="h-7 bg-background text-[11px]"
                                    >
                                        <SelectValue>{assertion.expectedNode}</SelectValue>
                                    </SelectTrigger>
                                    <SelectContent>
                                        {availableNodes.map((node) => (
                                            <SelectItem key={node} value={node}>
                                                {node}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                                <Button
                                    aria-label={t(
                                        'settings.environmentMonitor.mihomo.removeRoute',
                                        { domain: assertion.domain },
                                    )}
                                    className="size-7 min-h-0 p-0 text-muted hover:text-danger"
                                    size="icon"
                                    variant="ghost"
                                    onClick={() =>
                                        onChange({
                                            ...value,
                                            assertions: value.assertions.filter(
                                                (_, candidate) => candidate !== index,
                                            ),
                                        })
                                    }
                                >
                                    <Trash2 aria-hidden="true" size={13} />
                                </Button>
                            </li>
                        );
                    })}
                </ul>
            )}
            <div className="mt-3 grid grid-cols-[minmax(8rem,1fr)_minmax(10rem,1fr)_auto] gap-2">
                <Input
                    aria-label={t('settings.environmentMonitor.mihomo.domainLabel')}
                    placeholder="example.com"
                    value={domain}
                    onChange={(event) => setDomain(event.target.value)}
                />
                <Select
                    disabled={nodes.length === 0}
                    value={expectedNode || null}
                    onValueChange={(node) =>
                        setNodeCache((current) => ({
                            ...current,
                            expectedNode: node ?? '',
                        }))
                    }
                >
                    <SelectTrigger
                        aria-label={t('settings.environmentMonitor.mihomo.expectedNodeLabel')}
                        className="bg-background"
                    >
                        <SelectValue>
                            {expectedNode || t('settings.environmentMonitor.mihomo.loadNodesFirst')}
                        </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                        {nodes.map((node) => (
                            <SelectItem key={node} value={node}>
                                {node}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <Button
                    disabled={
                        nodes.length === 0 ||
                        value.assertions.length >= MAX_ENVIRONMENT_MONITOR_ROUTE_ASSERTIONS
                    }
                    size="sm"
                    onClick={addAssertion}
                >
                    {t('settings.environmentMonitor.mihomo.addRoute')}
                </Button>
            </div>
            {error ? (
                <FieldDescription className="mt-2" role="status" tone="danger">
                    {error}
                </FieldDescription>
            ) : null}
        </section>
    );
}
