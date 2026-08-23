# Caxri

Caxri organizes local development work around Projects, Sessions, Terminals, and the Agent activity that may require a user's attention.

## Language

**Project**:
A user-authorized local directory. A Session's owning Project remains its durable identity and the
root for its Terminals and Agent Endpoint.
_Avoid_: Workspace, repository

**Session**:
A durable unit of work within one owning Project that owns Terminals, root-scoped Workbench state,
layout, and attention state.
_Avoid_: Conversation, tab

**Workbench Root**:
The currently selected authorized Project whose Files, Editor, Search, and Git surfaces a Session
operate on. It may temporarily differ from the Session's owning Project when an Agent creates or
selects a linked Git worktree.
_Avoid_: Session Project, Terminal root

**Terminal**:
One Shell or Agent CLI process surface inside a Session.
_Avoid_: Session, pane

**Agent Session ID**:
The provider-owned conversation identity bound to an Agent Terminal. Caxri may mint this opaque ID
before launch when the provider supports caller-owned identity; it is distinct from the owning
Caxri Session ID.
_Avoid_: Session ID, Terminal ID, transcript path

**Primary Agent**:
The first Agent Terminal in a Session, which owns that Session's generated title, activity, and attention signals.
_Avoid_: Active Terminal, selected Agent

**Agent Activity**:
The Primary Agent's current reported state, independent of whether the user has seen it.
_Avoid_: Notification, unread state

**Attention**:
A reliable Primary Agent event that tells the user a Session is waiting, completed, or failed.
_Avoid_: Output, activity

**Unread Attention**:
Attention whose current generation has not been acknowledged after the Session was visibly focused.
_Avoid_: Activity, notification count
