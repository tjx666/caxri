import { useRef, useState } from 'react';

import type { SshHostAskpassRequest } from '@caxri/protocol';

import { Button } from '../../components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import { Spinner } from '../../components/ui/spinner';
import { useTranslation } from '../../i18n';
import { useSshEnvironment } from '../../stores/environment';
import { askpassAttempt, askpassTitleKey } from './askpass-copy';
import { didReplySshHostPrompt } from './ssh-host-commands';

/**
 * Shows OpenSSH's pending prompt (a password, key passphrase, 2FA code, or host-key question) that Main forwarded from
 * `SSH_ASKPASS`. The prompt lives in the environment state rather than in an event, so a window that loads after it was
 * raised still shows it. Keyed by request so a new prompt never inherits the previous answer.
 */
export function AskpassDialog() {
    const environment = useSshEnvironment();
    const request = environment?.askpass;
    if (!environment || !request) return null;
    return (
        <AskpassPrompt
            key={request.requestId}
            destination={environment.destination}
            request={request}
        />
    );
}

function AskpassPrompt({
    destination,
    request,
}: {
    destination: string;
    request: SshHostAskpassRequest;
}) {
    const { t } = useTranslation();
    const contentReference = useRef<HTMLDivElement>(null);
    /**
     * The answer stays in this component's state only: it is sent once and dropped with the component, and nothing here
     * logs, persists, or echoes it.
     */
    const [response, setResponse] = useState('');
    const [isAnswered, setIsAnswered] = useState(false);
    const isConfirm = request.kind === 'confirm';

    function answer(value: string | null): void {
        if (isAnswered) return;
        setIsAnswered(true);
        setResponse('');
        // eslint-disable-next-line no-void -- the reply reports its own failure through a toast
        void didReplySshHostPrompt(request.requestId, value).then((isDelivered) => {
            // Main clears the prompt from the environment state once it has the answer; until then a failed
            // delivery hands the controls back so the user can answer again.
            if (!isDelivered) setIsAnswered(false);
        });
    }

    return (
        <Dialog
            open
            /**
             * Cancelling fails the whole SSH attempt, so a stray click beside the dialog must not do it: only Escape
             * and Cancel answer the prompt that way.
             */
            disablePointerDismissal
            onOpenChange={(nextOpen) => {
                if (!nextOpen) answer(null);
            }}
        >
            <DialogContent
                ref={contentReference}
                className="ssh-host-askpass-dialog"
                showCloseButton={false}
                initialFocus={() =>
                    contentReference.current?.querySelector<HTMLElement>(
                        '[data-askpass-initial-focus]',
                    ) ?? null
                }
            >
                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        answer(isConfirm ? 'yes' : response);
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>{t(askpassTitleKey(request), { destination })}</DialogTitle>
                        {/* OpenSSH's host-key question spans several lines with a fingerprint, so line breaks are kept. */}
                        <DialogDescription className="max-h-[40vh] overflow-auto font-mono text-[12px] break-words whitespace-pre-wrap text-foreground">
                            {request.prompt}
                        </DialogDescription>
                    </DialogHeader>
                    {!isConfirm && (
                        <div className="flex flex-col gap-1 px-4 pt-4">
                            {request.retry !== undefined && (
                                <p className="m-0 text-[11px] text-danger" role="alert">
                                    {t('sshHost.askpass.retry', {
                                        count: askpassAttempt(request.retry),
                                    })}
                                </p>
                            )}
                            <Input
                                data-askpass-initial-focus
                                aria-label={t('sshHost.askpass.inputLabel')}
                                autoComplete="off"
                                spellCheck={false}
                                type={request.kind === 'secret' ? 'password' : 'text'}
                                value={response}
                                onChange={(event) => setResponse(event.target.value)}
                            />
                            <p className="m-0 text-[11px] text-muted">
                                {t('sshHost.askpass.privacy')}
                            </p>
                        </div>
                    )}
                    <div className="flex justify-end gap-2 p-4">
                        <Button
                            /*
                             * A host-key question defaults to No: trusting an unknown key is the choice a stray Enter
                             * must not make.
                             */
                            data-askpass-initial-focus={isConfirm ? true : undefined}
                            type="button"
                            variant="secondary"
                            disabled={isAnswered}
                            onClick={() => answer(isConfirm ? 'no' : null)}
                        >
                            {t('common.cancel')}
                        </Button>
                        {/* The labels say what happens; OpenSSH still receives the `yes`/`no` its question expects. */}
                        <Button type="submit" disabled={isAnswered}>
                            {isAnswered && <Spinner />}
                            {t(isConfirm ? 'sshHost.askpass.trust' : 'sshHost.askpass.continue')}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
