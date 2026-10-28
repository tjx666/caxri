import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from '../../components/ui/command';
import { Dialog, DialogTitle, PickerDialogContent } from '../../components/ui/dialog';
import { useTranslation } from '../../i18n';
import { useProjects, useSelectedSession, useSessions, useTerminals } from '../../stores/selectors';
import type { PaletteSearchEntry } from '../palette/palette-search';
import { paletteSearchScore } from '../palette/palette-search';
import { activeSessionsInSidebarOrder } from '../session/session-activity-order';
import { labelsFor } from '../session/session-label-snapshot';
import { sessionTitleForDisplay } from '../session/session-title';
import type { ShareRequest } from './share-request-store';
import { clearShareRequest, useShareRequestStore } from './share-request-store';
import { didShareToSession } from './share-to-session';

const NO_RECORDS: never[] = [];
const metaClassName = 'inline-flex flex-none items-center gap-2 text-[11px] text-muted';

/**
 * Asks which Session receives what the macOS Share menu handed to Caxri. Open while a request is pending; Escape drops
 * the request, leaving its files in the Share Inbox until they expire.
 */
export function ShareToSessionDialog() {
    const pending = useShareRequestStore((state) => state.pending);
    return (
        <Dialog
            open={pending !== undefined}
            onOpenChange={(isOpen) => {
                if (!isOpen) clearShareRequest();
            }}
        >
            <PickerDialogContent>
                {pending && <ShareToSessionBody request={pending} />}
            </PickerDialogContent>
        </Dialog>
    );
}

function ShareToSessionBody({ request }: { request: ShareRequest }) {
    const { t } = useTranslation();
    const projects = useProjects() ?? NO_RECORDS;
    const sessions = activeSessionsInSidebarOrder(projects, useSessions() ?? NO_RECORDS);
    const selectedSession = useSelectedSession();
    // The sidebar's label rule, so two Sessions sharing a title carry the same `#2` suffix here as in their rows.
    const labels = labelsFor(
        useSessions() ?? NO_RECORDS,
        projects,
        useTerminals(),
        t('session.untitled'),
    );
    const first = request.files.at(0);
    const summary = first
        ? request.files.length === 1
            ? t('share.receivedOne', { name: basename(first.path) })
            : t('share.receivedMany', {
                  name: basename(first.path),
                  count: request.files.length - 1,
              })
        : t('share.receivedText');
    /**
     * Rows are keyed `session:<id>`, as in the Command Palette, so two Sessions sharing a title still differ.
     */
    const searchEntries = new Map<string, PaletteSearchEntry>(
        sessions.map((session) => {
            const project = projects.find((item) => item.id === session.projectId);
            return [
                `session:${session.id}`,
                {
                    titles: [sessionTitleForDisplay(session.title, t), session.title],
                    details: [project?.title ?? '', project?.rootPath ?? ''],
                },
            ];
        }),
    );
    return (
        <>
            <DialogTitle className="sr-only">{t('share.title')}</DialogTitle>
            <Command
                label={t('share.title')}
                className="w-full"
                defaultValue={selectedSession && `session:${selectedSession.id}`}
                filter={(value, search) => paletteSearchScore(searchEntries.get(value), search)}
            >
                <CommandInput autoFocus placeholder={t('share.searchPlaceholder')} />
                <div className="truncate border-b border-border px-3 py-1.5 text-[11px] text-muted">
                    {summary}
                </div>
                <CommandList>
                    <CommandEmpty>{t('share.empty')}</CommandEmpty>
                    <CommandGroup heading={t('palette.group.sessions')}>
                        {sessions.map((session) => {
                            const project = projects.find((item) => item.id === session.projectId);
                            const label = labels.get(session.id);
                            return (
                                <CommandItem
                                    key={session.id}
                                    value={`session:${session.id}`}
                                    onSelect={() => {
                                        clearShareRequest();
                                        void didShareToSession(session.id, request);
                                    }}
                                >
                                    <span className="min-w-0 truncate">
                                        {label?.title ?? sessionTitleForDisplay(session.title, t)}
                                        {label?.suffix && (
                                            <span className="ml-1.5 text-[11px] text-muted">
                                                {label.suffix}
                                            </span>
                                        )}
                                    </span>
                                    <small className={metaClassName}>
                                        {project?.title ?? t('palette.source.session')}
                                    </small>
                                </CommandItem>
                            );
                        })}
                    </CommandGroup>
                </CommandList>
            </Command>
        </>
    );
}

function basename(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1);
}
