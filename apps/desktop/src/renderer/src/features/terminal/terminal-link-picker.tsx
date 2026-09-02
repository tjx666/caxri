import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from '../../components/ui/command';
import { Dialog, DialogTitle, PickerDialogContent } from '../../components/ui/dialog';
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
                    <span className="min-w-0 truncate" title={link.target}>
                        {link.target}
                    </span>
                    <small className="flex-none text-[11px] text-muted">
                        {link.detail ??
                            (link.kind === 'url'
                                ? 'External URL'
                                : link.kind === 'commit'
                                  ? 'Git commit'
                                  : 'File')}
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
    const urls = links.filter((link) => link.kind === 'url');
    const files = links.filter((link) => link.kind === 'file');
    const commits = links.filter((link) => link.kind === 'commit');
    const isCommitCandidates = mode === 'candidates' && commits.length > 0;
    /**
     * Remounts cmdk when activation replaces the detected-link search with an ambiguous-file chooser. Its input is
     * otherwise uncontrolled and retains the full detected path, filtering every safe display candidate out.
     */
    const commandKey = mode;
    return (
        <Dialog open={isOpen} onOpenChange={onOpenChange}>
            <PickerDialogContent>
                <DialogTitle className="sr-only">
                    {mode === 'candidates'
                        ? isCommitCandidates
                            ? 'Choose Git Repository'
                            : 'Choose Terminal File'
                        : 'Open Detected Link'}
                </DialogTitle>
                <Command
                    key={commandKey}
                    className="w-full"
                    label={
                        mode === 'candidates'
                            ? isCommitCandidates
                                ? 'Choose Git Repository'
                                : 'Choose Terminal File'
                            : 'Open Detected Link'
                    }
                >
                    <CommandInput
                        autoFocus
                        placeholder={
                            mode === 'candidates'
                                ? isCommitCandidates
                                    ? 'Search matching repositories…'
                                    : 'Search matching files…'
                                : 'Search links in the Terminal…'
                        }
                    />
                    <CommandList>
                        <CommandEmpty>
                            {mode === 'candidates'
                                ? isCommitCandidates
                                    ? 'No matching repositories.'
                                    : 'No matching files.'
                                : 'No links found in the Terminal buffer.'}
                        </CommandEmpty>
                        {mode === 'detected' && (
                            <TerminalLinkGroup heading="URLs" links={urls} onSelect={onSelect} />
                        )}
                        <TerminalLinkGroup
                            heading={mode === 'candidates' ? 'Matching files' : 'Files'}
                            links={files}
                            onSelect={onSelect}
                        />
                        <TerminalLinkGroup
                            heading={
                                mode === 'candidates' ? 'Matching repositories' : 'Git commits'
                            }
                            links={commits}
                            onSelect={onSelect}
                        />
                        {(status === 'exhausted' || isTruncated) && (
                            <div className="px-2 py-1.5 text-[11px] text-muted">
                                {mode === 'candidates'
                                    ? isCommitCandidates
                                        ? 'Commit search reached its safety limit; choose from the matches shown.'
                                        : 'File search reached its safety limit; choose from the matches shown.'
                                    : `Showing the first ${MAX_TERMINAL_DETECTED_LINKS} links.`}
                            </div>
                        )}
                    </CommandList>
                </Command>
            </PickerDialogContent>
        </Dialog>
    );
}
