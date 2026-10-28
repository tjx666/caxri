import { useState } from 'react';

import type { AirplaneModePhase, AirplaneModeState } from '@caxri/protocol';
import { Plane } from 'lucide-react';

import { Button } from '../../../components/ui/button';
import { Checkbox } from '../../../components/ui/checkbox';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '../../../components/ui/dialog';
import { Spinner } from '../../../components/ui/spinner';
import { useTranslation } from '../../../i18n';
import { useCaxriQuery } from '../../../queries/client';
import { useProjectById, useSessionById } from '../../../stores/selectors';
import { useSessionLabel } from '../hooks/use-session-label';
import {
    exitAirplaneMode,
    pickedAirplaneModeSessions,
    skipAirplaneModeCompaction,
} from './airplane-mode-commands';

/**
 * Airplane Mode holds the whole window while it is on (docs/airplane-mode.md): there is no close button, and Escape or
 * an outside press does nothing, because the only way out is choosing which Sessions to resume. The state is the
 * Server's, so every window shows the same dialog and it is still up after a restart.
 */
export function AirplaneModeDialog() {
    const { data: state } = useCaxriQuery('session.airplaneModeStatus', {});
    const phase = state?.phase;
    const isOpen = phase !== undefined && phase !== 'off';
    return (
        <Dialog open={isOpen} onOpenChange={() => {}}>
            <DialogContent
                className="airplane-mode-dialog grid max-h-[calc(100vh-48px)] w-[min(520px,calc(100vw-48px))] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden"
                showCloseButton={false}
            >
                {state && phase && phase !== 'off' && (
                    <AirplaneModeBody phase={phase} state={state} />
                )}
            </DialogContent>
        </Dialog>
    );
}

function AirplaneModeBody({
    phase,
    state,
}: {
    phase: Exclude<AirplaneModePhase, 'off'>;
    state: AirplaneModeState;
}) {
    const { t } = useTranslation();
    const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(() => new Set());
    const picked = pickedAirplaneModeSessions(state.parkedSessionIds, unchecked);
    const { compaction } = state;
    const continuing = new Set(state.continueSessionIds);
    return (
        <>
            <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                    <Plane aria-hidden="true" size={15} />
                    {t(`session.airplaneMode.title.${phase === 'on' ? 'on' : 'busy'}`)}
                </DialogTitle>
                <DialogDescription>
                    {t(`session.airplaneMode.description.${phase}`)}
                </DialogDescription>
            </DialogHeader>
            <div className="min-h-0 overflow-auto px-4 py-3">
                {phase === 'on' ? (
                    state.parkedSessionIds.length === 0 ? (
                        <p className="text-[13px] text-muted">{t('session.airplaneMode.none')}</p>
                    ) : (
                        <div
                            className="grid gap-1"
                            role="group"
                            aria-label={t('session.airplaneMode.listLabel')}
                        >
                            {state.parkedSessionIds.map((sessionId) => (
                                <ParkedSessionRow
                                    key={sessionId}
                                    sessionId={sessionId}
                                    willContinue={continuing.has(sessionId)}
                                    isChecked={!unchecked.has(sessionId)}
                                    onCheckedChange={(isChecked) =>
                                        setUnchecked((current) => {
                                            const next = new Set(current);
                                            if (isChecked) next.delete(sessionId);
                                            else next.add(sessionId);
                                            return next;
                                        })
                                    }
                                />
                            ))}
                        </div>
                    )
                ) : (
                    <p className="airplane-mode-progress flex items-center gap-2 text-[13px] text-muted">
                        <Spinner />
                        {phase === 'compacting' && compaction
                            ? t('session.airplaneMode.compactionPending', {
                                  pending: compaction.pending,
                                  submitted: compaction.submitted,
                              })
                            : t(`session.airplaneMode.progress.${phase}`)}
                    </p>
                )}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
                {phase === 'compacting' && (
                    <>
                        <Button
                            variant="ghost"
                            onClick={() => {
                                // Fire-and-forget: a failure reports itself through `tryCommand`.
                                void exitAirplaneMode([]);
                            }}
                        >
                            {t('common.cancel')}
                        </Button>
                        <Button
                            onClick={() => {
                                void skipAirplaneModeCompaction();
                            }}
                        >
                            {t('session.airplaneMode.skipCompaction')}
                        </Button>
                    </>
                )}
                {phase === 'on' && (
                    <Button
                        className="airplane-mode-resume"
                        onClick={() => {
                            void exitAirplaneMode(picked);
                        }}
                    >
                        {picked.length === 0
                            ? t('session.airplaneMode.exitWithoutResume')
                            : t(
                                  picked.length === 1
                                      ? 'session.airplaneMode.resumeOne'
                                      : 'session.airplaneMode.resumeOther',
                                  { count: picked.length },
                              )}
                    </Button>
                )}
                {(phase === 'parking' || phase === 'resuming') && (
                    <Button disabled aria-busy>
                        <Spinner />
                        {t(`session.airplaneMode.progress.${phase}`)}
                    </Button>
                )}
            </div>
        </>
    );
}

/**
 * One parked Session, labelled as the sidebar labels it, with its Project. A Session the sidebar does not list (Caxri
 * Bot's, or one archived since) still resumes, under a generic label. `willContinue` marks a Session whose Agent was
 * working on entry: resuming it also tells the Agent to continue.
 */
function ParkedSessionRow({
    isChecked,
    onCheckedChange,
    sessionId,
    willContinue,
}: {
    isChecked: boolean;
    onCheckedChange: (isChecked: boolean) => void;
    sessionId: string;
    willContinue: boolean;
}) {
    const { t } = useTranslation();
    const session = useSessionById(sessionId);
    const project = useProjectById(session?.projectId);
    // The sidebar's label, collision suffix included, so two untitled Sessions stay distinguishable.
    const label = useSessionLabel(sessionId);
    return (
        <label
            className="airplane-mode-session grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 rounded-md px-2 py-1.5 data-[checked=true]:bg-state-selected-quiet"
            data-checked={isChecked}
        >
            <Checkbox
                checked={isChecked}
                onCheckedChange={(next) => onCheckedChange(next === true)}
            />
            <span className="truncate text-[13px] text-foreground">
                {session ? label.title : t('session.airplaneMode.unlisted')}
                {session && label.suffix && <span className="ml-1 text-muted">{label.suffix}</span>}
                {willContinue && (
                    <span className="airplane-mode-continues ml-2 text-[11px] text-muted">
                        {t('session.airplaneMode.willContinue')}
                    </span>
                )}
            </span>
            {project && <span className="truncate text-[11px] text-muted">{project.title}</span>}
        </label>
    );
}
