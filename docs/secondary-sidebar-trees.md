---
kind: living
status: current
---

# Secondary Sidebar trees

The Secondary Sidebar hosts three tree views: Files, Source Control, and extension-contributed trees
such as Project Status. All three virtualize their rows, and all three share the side bar's scroll
cue. This page covers how Files and Source Control render. Extension trees are covered in
[extensions.md](extensions.md).

## Scroll cue

Every side bar body shows VS Code's `.shadow.top` once its scroller leaves the top. This includes
the Project tree, the Activity queue, and each Secondary Sidebar view. `useScrollEdge`
(`apps/desktop/src/renderer/src/hooks/use-scroll-edge.ts`) publishes `data-scrolled` on the overflow
box. A `.scroll-edge-shell` parent paints the inset shadow over the first visible row. A new
scrolling side bar body joins by wrapping its scroller in that shell and calling the hook. It does
not add its own shadow rule.

## Files

The Files tree is one flattened, virtualized list (`resource-explorer/file-tree.tsx`). Only rows
near the viewport are mounted, so expanding a directory with thousands of entries costs a screenful
of DOM.

- **Row model.** `flattenFileTree` (`file-tree-rows.ts`) turns the expanded listings into
  depth-first rows. Rows are entries, the inline create field, and the empty and truncated notices.
  Each directory keeps its own `files.list` query. `useFileTreeRows` requests a folder only after
  its parent listing contains it, so a stale expanded path left by a deleted folder is never read.
  Listings stay cached per Project, and hidden keep-alive panels pause them.
- **Rows keep their own state.** Expansion, selection, focus requests, and Git decorations are
  per-row store subscriptions. The tree passes only stable props into a memoized row, so scrolling
  re-renders only rows whose inputs changed.
- **Keyboard and reveal use the model.** Arrow keys, Home/End, and Left-to-parent resolve a target
  index in the row model. The tree scrolls that index into view and then sets the focus request,
  which the row honours once it mounts. Editor reveal scrolls through the same path. Both place the
  row below its would-be sticky ancestors (`fileTreeRevealOffset`) instead of calling
  `scrollIntoView`.
- **Following the editor costs nothing while hidden.** The pane layout moves on every work-tab
  switch, so exactly one Files component subscribes to it: a render-less follower
  (`resource-explorer-view.tsx`) that reveals the active tab's file and mounts only while the Files
  container is visible. A hidden Files view therefore renders nothing on a tab switch, a visible one
  re-renders only that follower, and revealing the container follows whichever tab is active by
  then. Refresh reads the active tab when pressed instead of subscribing to it.
- **The Tab stop stays mounted.** The selected row, or the first row when nothing is selected,
  always renders. So does the focused row. Tab can always re-enter the tree, and scrolling the
  focused row away does not drop focus to `<body>`.
- **Accessibility.** Rows are flat `treeitem`s with `aria-level`, `aria-posinset`, and
  `aria-setsize`, the way VS Code's list-backed trees expose depth. They are not nested in
  `role="group"` containers.

### Sticky ancestors

Ancestor directories stay pinned in an overlay, not through per-row `position: sticky`. Per-row
`sticky` depended on each subtree being nested in the DOM, which virtualization removes.
`stickyFileTreeRows` (`file-tree-row-style.ts`) derives the stack from the scroll offset. Slot `n`
holds the depth-`n` ancestor of the row just below the stack, up to `MAX_STICKY_ANCESTORS`. When
that ancestor's subtree runs out, the ancestor rides up with the subtree's last row and nothing
deeper pins, the same way the next sibling folder takes over in VS Code.

The overlay rows are visual duplicates, so they are `aria-hidden`. Clicking one scrolls the real row
back to its slot, then selects and focuses it. A shadow strip under the last pinned row separates
the stack from rows passing beneath it.

## Source Control

Each resource group's folder and file rows are virtualized
(`source-control/source-control-tree-items.tsx`). Every group runs its own virtualizer against the
single `role="tree"` scroller, offset by where the group starts. Provider headers, group captions,
File History, and the paged Commits history are not virtualized. They are bounded by page size,
and flattening them would unmount their paging and hover state.

Movement inside a group resolves against the group's row model
(`source-control-tree-rows.ts`). Movement across section edges still walks the DOM
(`source-control-tree-navigation.ts`). Each group keeps its first row, last row, and Tab stop row
mounted, so that DOM walk always reaches the true boundary row.
