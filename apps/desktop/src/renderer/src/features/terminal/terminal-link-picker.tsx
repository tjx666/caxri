import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from '../../components/ui/command';
import { Dialog, DialogTitle, PickerDialogContent } from '../../components/ui/dialog';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { terminalLinkPickerCopy } from './terminal-link-picker-presentation';
import type { TerminalLinkScanStatus } from './terminal-link-scanner';
import type { TerminalDetectedLink } from './terminal-links';
import { MAX_TERMINAL_DETECTED_LINKS } from './terminal-links';

interface TerminalLinkPickerProperties {
    isOpen: boolean;
    links: TerminalDetectedLink[];
    mode: 'candidates' | 'detected';
    status: TerminalLinkScanStatus;
    isTruncated: boolean;
    onOpenChange: (isOpen: boolean) => void;
    onSelect: (link: TerminalDetectedLink) => void;
}

function TerminalLinkGroup({
    heading,
    links,
    onSelect,
}: {
    heading: string;
    links: TerminalDetectedLink[];
    onSelect: (link: TerminalDetectedLink) => void;
}) {
    const { t } = useTranslation();
    if (links.length === 0) return null;
    return (
        <CommandGroup heading={heading}>
            {links.map((link) => (
                <CommandItem
                    aria-label={link.accessibleName}
                    data-terminal-link-kind={link.kind}
                    key={link.id}
                    value={`${link.accessibleName} ${link.target}`}
                    onSelect={() => onSelect(link)}
                >
                    <Tooltip content={link.target}>
                        <span className="min-w-0 truncate">{link.target}</span>
                    </Tooltip>
                    <small className="flex-none text-[11px] text-muted">
                        {link.detail ??
                            t(
                                link.kind === 'url'
                                    ? 'terminal.linkPicker.kind.url'
                                    : link.kind === 'commit'
                                      ? 'terminal.links.commit.detail'
                                      : 'terminal.linkPicker.kind.file',
                            )}
                    </small>
                </CommandItem>
            ))}
        </CommandGroup>
    );
}

/**
 * VS Code-style detected-link quick pick. Unlike xterm's mouse-only overlays, cmdk exposes a real listbox and options
 * with stable accessible names, while the selected descriptor still returns to the existing guarded activation path.
 */
export function TerminalLinkPicker({
    links,
    mode,
    onOpenChange,
    onSelect,
    isOpen,
    status,
    isTruncated,
}: TerminalLinkPickerProperties) {
    const { t } = useTranslation();
    const urls = links.filter((link) => link.kind === 'url');
    const files = links.filter((link) => link.kind === 'file');
    const commits = links.filter((link) => link.kind === 'commit');
    const isCommitCandidates = mode === 'candidates' && commits.length > 0;
    /**
     * Remounts cmdk when activation replaces the detected-link search with an ambiguous-file chooser. Its input is
     * otherwise uncontrolled and retains the full detected path, filtering every safe display candidate out.
     */
    const commandKey = mode;
    const copy = terminalLinkPickerCopy(t, mode, isCommitCandidates, status);
    return (
        <Dialog open={isOpen} onOpenChange={onOpenChange}>
            <PickerDialogContent>
                <DialogTitle className="sr-only">{copy.title}</DialogTitle>
                <Command key={commandKey} className="w-full" label={copy.title}>
                    <CommandInput autoFocus placeholder={copy.placeholder} />
                    <CommandList aria-busy={status === 'scanning'}>
                        <CommandEmpty>{copy.empty}</CommandEmpty>
                        {mode === 'detected' && (
                            <TerminalLinkGroup
                                heading={t('terminal.linkPicker.group.urls')}
                                links={urls}
                                onSelect={onSelect}
                            />
                        )}
                        <TerminalLinkGroup
                            heading={t(
                                mode === 'candidates'
                                    ? 'terminal.linkPicker.group.matchingFiles'
                                    : 'terminal.linkPicker.group.files',
                            )}
                            links={files}
                            onSelect={onSelect}
                        />
                        <TerminalLinkGroup
                            heading={t(
                                mode === 'candidates'
                                    ? 'terminal.linkPicker.group.matchingRepositories'
                                    : 'terminal.linkPicker.group.commits',
                            )}
                            links={commits}
                            onSelect={onSelect}
                        />
                        {(status === 'exhausted' || isTruncated) && (
                            <div className="px-2 py-1.5 text-[11px] text-muted">
                                {t(
                                    mode === 'candidates'
                                        ? isCommitCandidates
                                            ? 'terminal.linkPicker.limit.commits'
                                            : 'terminal.linkPicker.limit.files'
                                        : 'terminal.linkPicker.limit.detected',
                                    { count: MAX_TERMINAL_DETECTED_LINKS },
                                )}
                            </div>
                        )}
                    </CommandList>
                </Command>
            </PickerDialogContent>
        </Dialog>
    );
}
