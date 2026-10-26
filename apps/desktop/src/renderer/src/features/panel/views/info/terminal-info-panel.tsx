import type { TerminalRecord } from '@caxri/protocol';
import { agentTranscriptTabPath } from '@caxri/protocol';
import { capitalize } from 'es-toolkit';
import { CircleDot } from 'lucide-react';

import { FOCUSABLE_TOOLTIP_TRIGGER_CLASS, Tooltip } from '../../../../components/ui/tooltip';
import type { TranslationKey } from '../../../../i18n';
import { useTranslation } from '../../../../i18n';
import { resolveAgentIcon } from '../../../../icons/agents/agent-icon-registry';
import { AgentIdentityIcon } from '../../../../icons/agents/agent-identity-icon';
import { formatDateTime } from '../../../../lib/locale-format';
import { cn } from '../../../../lib/utilities';
import { useCaxriQuery } from '../../../../queries/client';
import { useSelectedSession, useSessionTerminals } from '../../../../stores/selectors';
import { openEditorTab } from '../../../editor/document-commands';
import { FAILURE_REASON_LABEL_KEYS } from '../../../terminal/terminal-exit-presentation';

const PROCESS_STATE_LABEL_KEYS: Record<TerminalRecord['lastProcessState'], TranslationKey> = {
    running: 'panel.terminalInfo.state.running',
    starting: 'panel.terminalInfo.state.starting',
    stopped: 'panel.terminalInfo.state.stopped',
    dead: 'panel.terminalInfo.state.dead',
    failed: 'panel.terminalInfo.state.failed',
    interrupted: 'panel.terminalInfo.state.interrupted',
    suspended: 'panel.terminalInfo.state.suspended',
    detached: 'panel.terminalInfo.state.detached',
};

const terminalStateColor: Record<TerminalRecord['lastProcessState'], string> = {
    running: 'text-success',
    starting: 'text-warning',
    stopped: 'text-muted',
    dead: 'text-danger',
    failed: 'text-danger',
    /**
     * Same treatment as `dead`: an interrupted Terminal is restoring in the background, not a live process.
     */
    interrupted: 'text-danger',
    /**
     * Parked on purpose (background suspension or a user hand-over): dormant, not broken.
     */
    suspended: 'text-muted',
    detached: 'text-muted',
};

/**
 * The transcript row queries the Server for the provider transcript's derived path (no content), and clicking it opens
 * the read-only transcript viewer tab.
 */
function TerminalTranscriptRow({ terminal }: { terminal: TerminalRecord }) {
    const { t } = useTranslation();
    const transcript = useCaxriQuery(
        'terminal.agentTranscript',
        { terminalId: terminal.id, withContent: false },
        { enabled: Boolean(terminal.provider && terminal.agentSessionId) },
    );
    if (!transcript.data) return null;
    return (
        <>
            <dt className="text-muted">{t('panel.terminalInfo.transcript')}</dt>
            <dd className="m-0 min-w-0 [overflow-wrap:anywhere]">
                <Tooltip
                    content={t(
                        transcript.data.exists
                            ? 'panel.terminalInfo.openTranscript'
                            : 'panel.terminalInfo.transcriptMissing',
                    )}
                >
                    <button
                        type="button"
                        className="cursor-pointer border-0 bg-transparent p-0 text-left text-accent underline-offset-2 hover:underline"
                        onClick={() => openEditorTab(agentTranscriptTabPath(terminal.id))}
                    >
                        {transcript.data.path}
                    </button>
                </Tooltip>
            </dd>
        </>
    );
}

/**
 * Scoped to the selected Session's Terminals so another Session's Agents never leak in here.
 */
export function TerminalInfoPanel() {
    const { t } = useTranslation();
    const session = useSelectedSession();
    const terminals = useSessionTerminals();
    if (!session)
        return (
            <div className="empty-panel px-3 py-4 text-center text-muted">
                {t('panel.terminalInfo.noSession')}
            </div>
        );
    if (terminals.length === 0)
        return (
            <div className="empty-panel px-3 py-4 text-center text-muted">
                {t('panel.terminalInfo.noTerminals')}
            </div>
        );

    return (
        <div className="panel-content terminal-info-panel min-h-0 flex-1 overflow-auto p-2">
            {terminals.map((terminal) => {
                const isPrimary = terminal.id === session.primaryAgentTerminalId;
                return (
                    <section
                        key={terminal.id}
                        className="terminal-info-card mb-2 rounded-md border border-border bg-background p-3"
                        data-terminal-info-id={terminal.id}
                    >
                        <div className="terminal-info-title flex items-center gap-2">
                            <AgentIdentityIcon identity={terminal.kind} size={15} />
                            <div className="min-w-0 flex-1">
                                <strong className="block truncate font-semibold">
                                    {terminal.title}
                                </strong>
                                {terminal.ptyTitle && terminal.ptyTitle !== terminal.title && (
                                    <Tooltip content={terminal.ptyTitle}>
                                        <span
                                            className={cn(
                                                'block truncate text-[11px] text-muted',
                                                FOCUSABLE_TOOLTIP_TRIGGER_CLASS,
                                            )}
                                            tabIndex={0}
                                        >
                                            {terminal.ptyTitle}
                                        </span>
                                    </Tooltip>
                                )}
                            </div>
                            {isPrimary && (
                                <span className="flex-none rounded bg-elevated px-1 text-[10px] text-muted">
                                    {t('panel.terminalInfo.titleSource')}
                                </span>
                            )}
                        </div>
                        <dl className="my-2 grid grid-cols-[64px_minmax(0,1fr)] gap-1 text-[11px]">
                            <dt className="text-muted">{t('panel.terminalInfo.type')}</dt>
                            <dd className="m-0 min-w-0 [overflow-wrap:anywhere]">
                                {resolveAgentIcon(terminal.kind).label}
                            </dd>
                            <dt className="text-muted">{t('panel.terminalInfo.status')}</dt>
                            <dd
                                className={cn(
                                    `terminal-state terminal-state-${terminal.lastProcessState}`,
                                    'flex items-center gap-1',
                                    terminalStateColor[terminal.lastProcessState],
                                )}
                            >
                                <CircleDot size={12} />
                                {t(PROCESS_STATE_LABEL_KEYS[terminal.lastProcessState])}
                            </dd>
                            {terminal.provider && (
                                <>
                                    <dt className="text-muted">
                                        {t('panel.terminalInfo.provider')}
                                    </dt>
                                    <dd className="m-0 min-w-0 [overflow-wrap:anywhere]">
                                        {capitalize(terminal.provider)}
                                    </dd>
                                </>
                            )}
                            {terminal.failureReason && (
                                <>
                                    <dt className="text-muted">
                                        {t('panel.terminalInfo.failure')}
                                    </dt>
                                    <dd className="m-0 min-w-0 [overflow-wrap:anywhere] text-danger">
                                        {t(FAILURE_REASON_LABEL_KEYS[terminal.failureReason])}
                                    </dd>
                                </>
                            )}
                            {terminal.processId && (
                                <>
                                    <dt className="text-muted">{t('panel.terminalInfo.pid')}</dt>
                                    <dd className="m-0 min-w-0 [overflow-wrap:anywhere]">
                                        {terminal.processId}
                                    </dd>
                                </>
                            )}
                            <dt className="text-muted">{t('panel.terminalInfo.directory')}</dt>
                            <dd className="m-0 min-w-0 [overflow-wrap:anywhere]">
                                <Tooltip content={terminal.cwd}>
                                    <span className={FOCUSABLE_TOOLTIP_TRIGGER_CLASS} tabIndex={0}>
                                        {terminal.cwd}
                                    </span>
                                </Tooltip>
                            </dd>
                            {terminal.agentSessionId && (
                                <>
                                    <dt className="text-muted">
                                        {t('panel.terminalInfo.agentSession')}
                                    </dt>
                                    <dd className="m-0 min-w-0 [overflow-wrap:anywhere]">
                                        {terminal.agentSessionId}
                                    </dd>
                                </>
                            )}
                            <TerminalTranscriptRow terminal={terminal} />
                            <dt className="text-muted">{t('panel.terminalInfo.created')}</dt>
                            <dd className="m-0 min-w-0 [overflow-wrap:anywhere]">
                                <Tooltip content={new Date(terminal.createdAt).toISOString()}>
                                    <span className={FOCUSABLE_TOOLTIP_TRIGGER_CLASS} tabIndex={0}>
                                        {formatDateTime(terminal.createdAt)}
                                    </span>
                                </Tooltip>
                            </dd>
                            <dt className="text-muted">{t('panel.terminalInfo.updated')}</dt>
                            <dd className="m-0 min-w-0 [overflow-wrap:anywhere]">
                                <Tooltip content={new Date(terminal.updatedAt).toISOString()}>
                                    <span className={FOCUSABLE_TOOLTIP_TRIGGER_CLASS} tabIndex={0}>
                                        {formatDateTime(terminal.updatedAt)}
                                    </span>
                                </Tooltip>
                            </dd>
                        </dl>
                    </section>
                );
            })}
        </div>
    );
}
