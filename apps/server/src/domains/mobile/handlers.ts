import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import type { PermissionAutoAllowStatus, Principal, ServerEvent } from '@caxri/protocol';
import {
    CaxriError,
    isBinaryFileReadError,
    MOBILE_FILES_MAX_ENTRIES,
    MOBILE_FILES_READ_MAX_BYTES,
    projectDisplayPath,
    readMobileMessageChunk,
} from '@caxri/protocol';

import type { AgentChatService } from '../agent-chat';
import type { AgentEndpointLifecycle } from '../agent-endpoints';
import type {
    AgentTimelineService,
    AgentTranscriptWatcher,
    PermissionAutoAllowAccess,
} from '../agents';
import { AgentAttentionRequests } from '../agents';
import type { ConfigService } from '../config';
import type { CaxriDatabase } from '../db';
import type { DomainHandlers } from '../domain-services';
import type { FileService } from '../files';
import type { GitService } from '../git';
import type { TerminalManager } from '../terminal';
import { createMobileAgentAvailabilityHandler } from './agent-availability';
import { createMobileAgentSubmitHandler } from './agent-submit';
import { MobileFileStore } from './file-store';
import { MobileImageStore } from './image-store';
import { createMobileProjectAddHandler, createMobileProjectBrowseHandler } from './project-browse';
import type { MobileTerminalMutationQueue } from './terminal-mutation-queue';

type MobileDomainMethods = Pick<
    DomainHandlers,
    | 'mobile.agent.availability'
    | 'mobile.agent.availabilityInternal'
    | 'mobile.agent.submit'
    | 'mobile.agent.submitInternal'
    | 'mobile.attention.list'
    | 'mobile.attention.listInternal'
    | 'mobile.attention.answer'
    | 'mobile.attention.answerInternal'
    | 'mobile.attention.autoAllowRevoke'
    | 'mobile.attention.autoAllowRevokeInternal'
    | 'mobile.image.upload'
    | 'mobile.image.uploadInternal'
    | 'mobile.image.readInternal'
    | 'mobile.file.upload'
    | 'mobile.file.uploadInternal'
    | 'mobile.file.pathsInternal'
    | 'mobile.changes.list'
    | 'mobile.changes.listInternal'
    | 'mobile.changes.diff'
    | 'mobile.changes.diffInternal'
    | 'mobile.session.show'
    | 'mobile.session.projectRootInternal'
    | 'mobile.timeline.read'
    | 'mobile.timeline.readInternal'
    | 'mobile.timeline.readMessage'
    | 'mobile.timeline.readMessageInternal'
    | 'mobile.timeline.watchInternal'
    | 'mobile.timeline.unwatchInternal'
    | 'mobile.chatWatch.watchInternal'
    | 'mobile.chatWatch.unwatchInternal'
    | 'mobile.project.browse'
    | 'mobile.project.browseInternal'
    | 'mobile.project.add'
    | 'mobile.project.addInternal'
    | 'mobile.project.reorder'
    | 'mobile.panels.list'
    | 'mobile.tree.children'
    | 'mobile.tree.executeCommand'
    | 'mobile.files.list'
    | 'mobile.files.listInternal'
    | 'mobile.preview.rootsInternal'
    | 'mobile.files.read'
    | 'mobile.files.readInternal'
    | 'mobile.files.search'
    | 'mobile.files.searchInternal'
    | 'mobile.files.write'
    | 'mobile.update.check'
    | 'mobile.update.prepare'
    | 'mobile.files.writeInternal'
>;

function authorizedSession(database: CaxriDatabase, sessionId: string, principal: Principal) {
    if (principal.kind !== 'paired-device')
        throw new CaxriError('FORBIDDEN', 'Paired device is required');
    const session = database.getSession(sessionId);
    if (
        !session ||
        !principal.projectIds.includes(session.projectId) ||
        database.listVisibleProjects().every((project) => project.id !== session.projectId)
    )
        throw new CaxriError('NOT_FOUND', 'Session not found');
    return session;
}

export function createMobileDomainHandlers(options: {
    attentionRequests?: AgentAttentionRequests;
    configuration: ConfigService;
    database: CaxriDatabase;
    emit: (event: ServerEvent) => void;
    endpoints?: AgentEndpointLifecycle;
    files: FileService;
    /**
     * "Always allow in this Session" (issue caxri#1295). Optional so a fixture that never exercises the grant can omit
     * it; the default reports every Session as ungranted.
     */
    autoAllow?: Partial<PermissionAutoAllowAccess>;
    git: GitService;
    imageDirectory?: string;
    fileDirectory?: string;
    queue: MobileTerminalMutationQueue;
    terminals: TerminalManager;
    timeline: AgentTimelineService;
    transcripts: AgentTranscriptWatcher;
    /**
     * Counts phones watching each Agent Chat. Optional so a fixture that never subscribes to a Chat can omit it.
     */
    agentChat?: Pick<AgentChatService, 'unwatchMobile' | 'watchMobile'>;
}): MobileDomainMethods {
    const attentionRequests = options.attentionRequests ?? new AgentAttentionRequests();
    const noAutoAllowGrant = (): PermissionAutoAllowStatus => ({ granted: false });
    const attentionAutoAllowStatus =
        options.autoAllow?.attentionAutoAllowStatus ?? noAutoAllowGrant;
    const grantAutoAllow = options.autoAllow?.grantAutoAllow ?? noAutoAllowGrant;
    const revokeAutoAllow = options.autoAllow?.revokeAutoAllow ?? noAutoAllowGrant;
    const images = new MobileImageStore(options.imageDirectory);
    const files = new MobileFileStore(options.fileDirectory);
    const browseProject = createMobileProjectBrowseHandler({});
    const addProject = createMobileProjectAddHandler({
        database: options.database,
        emit: options.emit,
    });
    return {
        'mobile.attention.list': () => {
            throw new CaxriError('FORBIDDEN', 'Mobile attention requires a paired device');
        },
        'mobile.attention.listInternal': ({ sessionId, principal }) => {
            authorizedSession(options.database, sessionId, principal);
            return {
                requests: attentionRequests.list(sessionId),
                autoAllow: attentionAutoAllowStatus(sessionId),
            };
        },
        'mobile.attention.answer': () => {
            throw new CaxriError('FORBIDDEN', 'Mobile attention requires a paired device');
        },
        'mobile.attention.answerInternal': ({
            sessionId,
            requestId,
            decision,
            answers,
            autoAllow,
            principal,
        }) => {
            if (principal.kind !== 'paired-device' || principal.role !== 'control')
                throw new CaxriError(
                    'FORBIDDEN',
                    'Control access is required to answer Agent requests',
                );
            authorizedSession(options.database, sessionId, principal);
            const result = attentionRequests.answer(sessionId, requestId, { decision, answers });
            // Grant only after the answer itself validated; a rejected answer must not enable auto-allow.
            if (autoAllow && decision === 'allow') grantAutoAllow(sessionId);
            return result;
        },
        'mobile.attention.autoAllowRevoke': () => {
            throw new CaxriError('FORBIDDEN', 'Mobile attention requires a paired device');
        },
        'mobile.attention.autoAllowRevokeInternal': ({ sessionId, principal }) => {
            if (principal.kind !== 'paired-device' || principal.role !== 'control')
                throw new CaxriError(
                    'FORBIDDEN',
                    'Control access is required to revoke Agent auto-allow',
                );
            authorizedSession(options.database, sessionId, principal);
            return revokeAutoAllow(sessionId, 'user');
        },
        'mobile.agent.availability': () => {
            throw new CaxriError('FORBIDDEN', 'Mobile Agent availability requires a paired device');
        },
        'mobile.agent.availabilityInternal': createMobileAgentAvailabilityHandler(options),
        'mobile.agent.submit': () => {
            throw new CaxriError('FORBIDDEN', 'Mobile Agent input requires a paired device');
        },
        'mobile.agent.submitInternal': createMobileAgentSubmitHandler({
            ...options,
            images,
            uploads: files,
        }),
        'mobile.image.upload': () => {
            throw new CaxriError('FORBIDDEN', 'Mobile image upload requires a paired device');
        },
        'mobile.image.uploadInternal': async ({
            sessionId,
            attachmentId,
            chunkIndex,
            chunkCount,
            chunk,
            principal,
        }) => {
            if (principal.kind !== 'paired-device' || principal.role === 'view')
                throw new CaxriError('FORBIDDEN', 'Device cannot attach images');
            authorizedSession(options.database, sessionId, principal);
            return images.upload({
                sessionId,
                attachmentId,
                chunkIndex,
                chunkCount,
                chunk,
                owner: `${principal.deviceId}:${principal.generation}`,
            });
        },
        'mobile.image.readInternal': async ({ sessionId, attachmentIds, principal }) => {
            if (principal.kind !== 'paired-device' || principal.role === 'view')
                throw new CaxriError('FORBIDDEN', 'Device cannot attach images');
            authorizedSession(options.database, sessionId, principal);
            return images.read(
                `${principal.deviceId}:${principal.generation}`,
                sessionId,
                attachmentIds,
            );
        },
        'mobile.file.upload': () => {
            throw new CaxriError('FORBIDDEN', 'Mobile file upload requires a paired device');
        },
        'mobile.file.uploadInternal': async ({ principal, ...parameters }) => {
            if (principal.kind !== 'paired-device' || principal.role === 'view')
                throw new CaxriError('FORBIDDEN', 'Device cannot attach files');
            authorizedSession(options.database, parameters.sessionId, principal);
            return files.upload({
                ...parameters,
                owner: `${principal.deviceId}:${principal.generation}`,
            });
        },
        'mobile.file.pathsInternal': ({ sessionId, attachmentIds, principal }) => {
            if (principal.kind !== 'paired-device' || principal.role === 'view')
                throw new CaxriError('FORBIDDEN', 'Device cannot attach files');
            authorizedSession(options.database, sessionId, principal);
            return files.paths(
                `${principal.deviceId}:${principal.generation}`,
                sessionId,
                attachmentIds,
            );
        },
        'mobile.changes.list': () => {
            throw new CaxriError('FORBIDDEN', 'Mobile changes require a paired device');
        },
        'mobile.changes.listInternal': ({ sessionId, refresh, principal }) => {
            authorizedSession(options.database, sessionId, principal);
            return options.git.mobileChangesList(sessionId, refresh);
        },
        'mobile.changes.diff': () => {
            throw new CaxriError('FORBIDDEN', 'Mobile diff requires a paired device');
        },
        'mobile.changes.diffInternal': ({ sessionId, repositoryId, path, principal }) => {
            authorizedSession(options.database, sessionId, principal);
            return options.git.mobileChangesDiff(sessionId, repositoryId, path);
        },
        'mobile.session.projectRootInternal': ({ sessionId, principal }) => ({
            rootPath: authorizedSession(options.database, sessionId, principal).rootPath,
        }),
        'mobile.session.show': () => {
            throw new CaxriError('FORBIDDEN', 'Mobile Session view requires a paired device');
        },
        'mobile.timeline.read': () => {
            throw new CaxriError('FORBIDDEN', 'Mobile timeline requires a paired device');
        },
        'mobile.timeline.readInternal': async ({ sessionId, before, limit, principal }) => {
            const session = authorizedSession(options.database, sessionId, principal);
            const terminalId = session.primaryAgentTerminalId;
            if (!terminalId)
                return {
                    status: options.database
                        .listTerminals(sessionId)
                        .some((terminal) => terminal.kind === 'shell')
                        ? ('unsupported' as const)
                        : ('missing' as const),
                    items: [],
                    truncated: false,
                    cursorExpired: false,
                };
            return options.timeline.read(sessionId, terminalId, before, limit);
        },
        'mobile.timeline.readMessage': () => {
            throw new CaxriError('FORBIDDEN', 'Mobile timeline requires a paired device');
        },
        'mobile.timeline.readMessageInternal': async ({ sessionId, itemId, offset, principal }) => {
            const session = authorizedSession(options.database, sessionId, principal);
            const terminalId = session.primaryAgentTerminalId;
            const text = terminalId
                ? await options.timeline.readMessage(sessionId, terminalId, itemId)
                : undefined;
            if (!text)
                throw new CaxriError('NOT_FOUND', 'This message is no longer in the transcript');
            return readMobileMessageChunk(text, offset);
        },
        'mobile.timeline.watchInternal': async ({ sessionId, principal }) => {
            const session = authorizedSession(options.database, sessionId, principal);
            const terminalId = session.primaryAgentTerminalId;
            if (terminalId) await options.transcripts.watchMobile(terminalId);
            return { ...(terminalId && { terminalId }) };
        },
        'mobile.timeline.unwatchInternal': ({ terminalId }) => {
            options.transcripts.unwatchMobile(terminalId);
            return null;
        },
        'mobile.chatWatch.watchInternal': ({ terminalId }) => {
            options.agentChat?.watchMobile(terminalId);
            return null;
        },
        'mobile.chatWatch.unwatchInternal': ({ terminalId }) => {
            options.agentChat?.unwatchMobile(terminalId);
            return null;
        },
        'mobile.project.browse': () => {
            throw new CaxriError('FORBIDDEN', 'Mobile Project browsing requires a paired device');
        },
        'mobile.project.browseInternal': ({ path, principal }) => {
            if (principal.kind !== 'paired-device' || principal.role !== 'control')
                throw new CaxriError('FORBIDDEN', 'Adding a Project requires the control role');
            return browseProject({ path });
        },
        'mobile.project.add': () => {
            throw new CaxriError('FORBIDDEN', 'Adding a Project requires a paired device');
        },
        'mobile.project.addInternal': ({ path, principal }) => {
            if (principal.kind !== 'paired-device' || principal.role !== 'control')
                throw new CaxriError('FORBIDDEN', 'Adding a Project requires the control role');
            return addProject({ path });
        },
        'mobile.project.reorder': () => {
            throw new CaxriError('FORBIDDEN', 'Reordering Projects requires a paired device');
        },
        /**
         * Panels and Conversation Tree read the Extension Host directly from the mobile access controller, which is the
         * only layer holding a live `ExtensionService` reference; these entries only satisfy `DomainHandlers`
         * completeness for a method that a paired device never reaches through `domainService.request`.
         */
        'mobile.panels.list': () => {
            throw new CaxriError('FORBIDDEN', 'Mobile panels require a paired device');
        },
        'mobile.tree.children': () => {
            throw new CaxriError('FORBIDDEN', 'Mobile Conversation Tree requires a paired device');
        },
        'mobile.tree.executeCommand': () => {
            throw new CaxriError('FORBIDDEN', 'Mobile tree actions require a paired device');
        },
        'mobile.preview.rootsInternal': ({ sessionId, principal }) => {
            const session = authorizedSession(options.database, sessionId, principal);
            const roots = new Set([session.rootPath]);
            for (const terminal of options.database.listTerminals(sessionId)) {
                roots.add(terminal.cwd);
                if (terminal.agentCwd) roots.add(terminal.agentCwd);
            }
            return { roots: [...roots].slice(0, 256) };
        },
        'mobile.files.list': () => {
            throw new CaxriError('FORBIDDEN', 'Mobile files require a paired device');
        },
        'mobile.files.listInternal': async ({ sessionId, directory, principal }) => {
            authorizedSession(options.database, sessionId, principal);
            const listing = await options.files.listDirectory(sessionId, directory);
            /**
             * Desktop lists up to `MAX_FILE_LIST_ENTRIES`; the mobile reply is bounded tighter, so a large directory is
             * cut here and reported as truncated instead of failing the reply schema.
             */
            return listing.entries.length > MOBILE_FILES_MAX_ENTRIES
                ? { entries: listing.entries.slice(0, MOBILE_FILES_MAX_ENTRIES), truncated: true }
                : listing;
        },
        'mobile.files.read': () => {
            throw new CaxriError('FORBIDDEN', 'Mobile files require a paired device');
        },
        'mobile.files.readInternal': async ({ sessionId, path, principal }) => {
            authorizedSession(options.database, sessionId, principal);
            try {
                const document = await options.files.read(sessionId, path);
                /**
                 * The Editor's safety limit is larger than one mobile reply may carry, so a file between the two limits
                 * is reported as oversized rather than failing the reply schema.
                 */
                if (Buffer.byteLength(document.content, 'utf8') > MOBILE_FILES_READ_MAX_BYTES)
                    return { status: 'oversized' as const };
                /**
                 * A file a message cited by its absolute path reads back as one; the phone cannot know the Project
                 * root, so name a file inside it Project-relative here, as Desktop names an Agent's files.
                 */
                const { root } = await options.files.resolveSessionPath(sessionId);
                return {
                    status: 'available' as const,
                    path: projectDisplayPath(document.path, root),
                    content: document.content,
                    mtimeMs: document.mtimeMs,
                    size: document.size,
                    contentHash: createHash('sha256').update(document.content).digest('hex'),
                    ...(document.readOnly !== undefined && { readOnly: document.readOnly }),
                };
            } catch (error) {
                /**
                 * `DocumentService.read` throws rather than returning a discriminated result; mobile matches on the
                 * code it uses for a size limit and the stable reason of a binary sniff so every other failure (missing
                 * file, concurrent modification, path denial) still propagates as a hard error instead of a soft
                 * status.
                 */
                if (error instanceof CaxriError && error.code === 'CAPACITY')
                    return { status: 'oversized' as const };
                if (isBinaryFileReadError(error)) return { status: 'binary' as const };
                throw error;
            }
        },
        'mobile.files.write': () => {
            throw new CaxriError('FORBIDDEN', 'Mobile file writes require a paired device');
        },
        /**
         * The update bundle and its download tokens live with the gateway's HTTP endpoint in the access controller.
         */
        'mobile.update.check': () => {
            throw new CaxriError('FORBIDDEN', 'Mobile updates require a paired device');
        },
        'mobile.update.prepare': () => {
            throw new CaxriError('FORBIDDEN', 'Mobile updates require a paired device');
        },
        'mobile.files.search': () => {
            throw new CaxriError('FORBIDDEN', 'Mobile file search requires a paired device');
        },
        'mobile.files.searchInternal': async ({ sessionId, query, principal }) => {
            authorizedSession(options.database, sessionId, principal);
            const result = await options.files.search({
                sessionId,
                consumer: 'mobile-composer',
                mode: 'name',
                query,
                caseSensitive: false,
                wholeWord: false,
                regex: false,
                include: '',
                exclude: '',
                useIgnoreFiles: true,
            });
            const paths = result.matches
                .map((match) => match.relativePath)
                .filter((path) => path.length <= 2_048);
            return {
                paths: paths.slice(0, 40),
                truncated:
                    result.truncated || paths.length !== result.matches.length || paths.length > 40,
            };
        },
        'mobile.files.writeInternal': async ({
            sessionId,
            path,
            content,
            expectedContentHash,
            principal,
        }) => {
            if (principal.kind !== 'paired-device' || principal.role !== 'control')
                throw new CaxriError('FORBIDDEN', 'Control access is required to edit files');
            authorizedSession(options.database, sessionId, principal);
            const document = await options.files.write(
                sessionId,
                path,
                content,
                expectedContentHash,
            );
            return {
                status: 'available' as const,
                path: document.path,
                content: document.content,
                mtimeMs: document.mtimeMs,
                size: document.size,
                contentHash: createHash('sha256').update(document.content).digest('hex'),
                ...(document.readOnly !== undefined && { readOnly: document.readOnly }),
            };
        },
    };
}
