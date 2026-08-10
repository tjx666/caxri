# Caxri

Caxri organizes local development work around Projects, Sessions, Terminals, and the Agent activity that may require a user's attention.

## Language

**Project**:
A user-added local directory that owns Sessions.
_Avoid_: Workspace, repository

**Session**:
A durable unit of work within one Project that owns Terminals, layout, navigation state, and attention state.
_Avoid_: Conversation, tab

**Terminal**:
One Shell or Agent CLI process surface inside a Session.
_Avoid_: Session, pane

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
