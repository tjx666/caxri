import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from '../../components/ui/command';
import { Dialog, DialogContent, DialogTitle } from '../../components/ui/dialog';
import type { TerminalDetectedLink } from './terminal-links';

interface TerminalLinkPickerProperties {
    isOpen: boolean;
    links: TerminalDetectedLink[];
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
                        {link.kind === 'url' ? 'External URL' : 'File'}
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
    onOpenChange,
    onSelect,
    isOpen,
}: TerminalLinkPickerProperties) {
    const urls = links.filter((link) => link.kind === 'url');
    const files = links.filter((link) => link.kind === 'file');
    return (
        <Dialog open={isOpen} onOpenChange={onOpenChange}>
            <DialogContent
                className="top-[18%] w-[min(560px,calc(100vw-32px))] translate-y-0 overflow-hidden"
                showCloseButton={false}
            >
                <DialogTitle className="sr-only">Open Detected Link</DialogTitle>
                <Command className="w-full" label="Open Detected Link">
                    <CommandInput autoFocus placeholder="Search links in the visible Terminal…" />
                    <CommandList>
                        <CommandEmpty>No link found in the visible Terminal.</CommandEmpty>
                        <TerminalLinkGroup heading="URLs" links={urls} onSelect={onSelect} />
                        <TerminalLinkGroup heading="Files" links={files} onSelect={onSelect} />
                    </CommandList>
                </Command>
            </DialogContent>
        </Dialog>
    );
}
