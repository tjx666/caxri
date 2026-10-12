# Caxri

Caxri organizes development work around independently deployed Servers, the Clients that connect to
them, and durable Projects, Sessions, Terminals, and Agent activity.

This glossary defines the current language after the architecture cutover. `_Avoid_` constrains new
design and code. It does not rename frozen public compatibility identifiers such as `host.status`;
those identifiers need a separate product and protocol change. For how a term's owning system
actually works, see the indexed living docs at [docs/README.md](docs/README.md).

## Execution environment

**Server**:
An independently deployable, single-tenant Caxri execution environment that owns authorized
Projects, durable work state, and managed processes.
_Avoid_: Host, backend, Local Server, Remote Server

**Client**:
A Desktop, CLI, Web, Mobile, or Agent Endpoint that connects to a Server under an explicit grant.
_Avoid_: Frontend, UI owner

**Session View**:
One Client's presentation of a Session, including its pane layout, open resources, selection, and
an optional Workbench Root override. It never owns the resources it presents.
_Avoid_: Session state, Desktop state

## Work

**Project**:
A folder accessible to and explicitly authorized for a Server. A Project owns exactly one root,
regardless of whether the connecting Client runs on the same machine.
_Avoid_: Workspace, repository, directory (except for filesystem primitives)

**Session**:
A durable unit of work within one owning Project that owns Terminals, the shared Workbench Root,
document Drafts, and Agent activity and Attention.
_Avoid_: Conversation, tab, Session View

**Workbench Root**:
The currently selected authorized Project whose Files, Editor, Search, and Git surfaces a Session
operates on. A Session View may temporarily override it without changing the Session's owning
Project.
_Avoid_: Session Project, Terminal root, Client root

**Draft**:
Durable unsaved document content owned by a Session and Workbench Root and protected by a Server
revision until it is saved or discarded.
_Avoid_: Dirty flag, tab content, Client buffer

**Terminal**:
One Shell or Agent CLI process surface inside a Session.
_Avoid_: Session, pane

**Chat**:
An Agent Terminal created with the chat surface: the same Agent CLI driven through its vendor's
structured protocol and shown as a conversation instead of a terminal grid. The same Agent
Terminal can switch between the chat and terminal surfaces and keep its Agent Session.
_Avoid_: Conversation, chat mode, Agent panel

## Agents and attention

**Agent Session**:
A provider-owned conversation identity that may continue across more than one Agent Run.
_Avoid_: Session, Caxri Session

**Agent Run**:
One Agent CLI process lifecycle inside a Terminal. Resuming the same Agent Session in a new process
starts a new Agent Run.
_Avoid_: Conversation, Terminal, generation

**Conversation**:
A read view of one Agent Session's prompts, replies, and tool activity, such as the Conversation
segment of a mobile Session screen. It presents an Agent Session; it is never a Session, Chat, or
Agent Run.
_Avoid_: Chat history, Agent log

**Primary Agent**:
The first Agent Terminal in a Session, which owns that Session's generated title, activity, and
attention signals.
_Avoid_: Active Terminal, selected Agent

**Session Activity**:
The latest content-free, Server-persisted evidence that work in a Session meaningfully progressed.
Creation, submitted Terminal input, and allowlisted Primary Agent lifecycle transitions advance it;
visits, arbitrary row writes, output chunks, metadata reconciliation, and recovery do not.
_Avoid_: Agent Activity, Attention, last opened, updated timestamp

**Agent Activity**:
The Primary Agent's current reported state, independent of whether the user has seen it.
_Avoid_: Session Activity, notification, unread state

**Attention**:
A reliable Primary Agent event that tells the user a Session is waiting, completed, or failed.
_Avoid_: Output, activity

**Commander Inbox**:
The items the Agent Commander explicitly raised for the user to act on: pull requests it verified as
ready to merge and questions only the user can answer, shown as "Needs you" in the Agent Commander
window. An item exists only because the Commander reported it.
_Avoid_: Peer Inbox, Agent Inbox, notifications, to-do list

**Peer Inbox**:
The Server-mediated, text-only channel through which managed Agents send, wait for, and reply to
short Peer Messages (`caxri agent message`). A message the user must approve is held, and the user
decides on it from the Desktop; a message is never typed into a Terminal.
_Avoid_: Caxri Inbox, Agent Inbox, Commander Inbox, chat

**Unread Attention**:
Attention whose current generation has not been acknowledged by any Client. Visibly focusing the
Session is one acknowledgement path, a hook-reported new Agent turn superseding it is another, and
acknowledgement is shared across all Clients.
_Avoid_: Activity, per-device notification count
