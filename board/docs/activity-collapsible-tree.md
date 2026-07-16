# Activity Page: Collapsible Tree Nodes

## Status

Not implemented. The data model supports it; the UI does not yet use it.

## Background

Every row in the Activity page maps to an `agent_graph.agent_activity_steps` record. The table has two fields that encode a parent-child hierarchy:

- `parent_step_id` — UUID reference to the parent step (nullable; root steps have no parent)
- `depth` — denormalized integer depth (0 = root, 1 = direct child, etc.)

The current UI uses `depth` to indent rows but otherwise renders a flat list. With many steps per campaign iteration, the feed becomes dense and hard to scan. Collapsible nodes would let a board member collapse an entire subtree (e.g., one campaign iteration's LLM calls) to focus on the top-level picture.

## Data Shape

```
campaign_iteration  (depth=0, id=A)
  ├── context_load  (depth=1, parent=A, id=B)
  ├── llm_call      (depth=1, parent=A, id=C)
  └── gate_check    (depth=1, parent=A, id=D)
        └── decision (depth=2, parent=D, id=E)
```

The API already returns all fields needed to reconstruct the tree. No backend changes are required.

## Implementation Plan

### 1. Build a tree structure from the flat list

After `fetchFull` / `fetchIncremental` populates `steps`, derive a parallel tree before rendering:

```ts
interface TreeNode {
  step: ActivityStep;
  children: TreeNode[];
}

function buildTree(steps: ActivityStep[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];

  for (const step of steps) {
    byId.set(step.id, { step, children: [] });
  }
  for (const step of steps) {
    const node = byId.get(step.id)!;
    if (step.parent_step_id && byId.has(step.parent_step_id)) {
      byId.get(step.parent_step_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}
```

Store the result in a `useMemo` derived from `steps`. Re-derive on every incremental append.

### 2. Track collapsed state

```ts
const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

function toggleCollapse(id: string) {
  setCollapsed(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
}
```

Only nodes with `children.length > 0` should render a toggle control.

### 3. Recursive render

Replace the flat `steps.map(...)` with a recursive `renderNode` function:

```tsx
function renderNode(node: TreeNode, collapsed: Set<string>, toggle: (id: string) => void) {
  const isCollapsed = collapsed.has(node.step.id);
  const hasChildren = node.children.length > 0;

  return (
    <div key={node.step.id}>
      <StepRow
        step={node.step}
        hasChildren={hasChildren}
        isCollapsed={isCollapsed}
        onToggleCollapse={hasChildren ? () => toggle(node.step.id) : undefined}
      />
      {!isCollapsed && node.children.map(child => renderNode(child, collapsed, toggle))}
    </div>
  );
}
```

### 4. StepRow changes

Add a collapse toggle to the left side of the row (between status dot and step icon):

```tsx
{hasChildren && (
  <button
    onClick={(e) => { e.stopPropagation(); onToggleCollapse?.(); }}
    className="shrink-0 text-zinc-600 hover:text-zinc-300 text-xs w-3 text-center"
  >
    {isCollapsed ? "▶" : "▼"}
  </button>
)}
```

When collapsed, show a subtle badge indicating how many children are hidden:

```tsx
{isCollapsed && node.children.length > 0 && (
  <span className="text-[10px] text-zinc-700 ml-1">
    +{countDescendants(node)} hidden
  </span>
)}
```

### 5. Failed-only filter interaction

When `showFailedOnly` is active, the tree should be flattened back to a list (bypassing `buildTree`) — collapsing a parent could hide a visible failed child, which is confusing. Switch to flat rendering whenever `showFailedOnly` is true.

### 6. Auto-scroll interaction

When new steps are appended incrementally and the user is at the bottom, `scrollToBottom` fires. If the new step is a child of a collapsed node, it won't be visible. Either:

- Auto-expand collapsed nodes that receive new children, or
- Skip auto-scroll when the newest step is under a collapsed ancestor

The simpler option is to auto-expand. Track this in `fetchIncremental` by checking whether the parent of any new step is currently in the `collapsed` set and removing it.

## Edge Cases

- **Orphaned steps**: steps whose `parent_step_id` does not appear in the current window (e.g., the parent was cut off by the 200-row limit). Treat these as roots.
- **Cycles**: not possible by DB constraint, but `buildTree` should guard anyway with a depth cap.
- **Incremental appends**: new steps may be children of existing nodes. `buildTree` must re-run on every append, not just on full fetches.
- **Agent filter**: when the agent filter is active, parent steps from other agents may be absent. Orphan handling above covers this — affected steps render as roots with their own indentation reset.

## Files to Change

| File | Change |
|------|--------|
| `dashboard/src/app/activity/page.tsx` | Add `buildTree`, `collapsed` state, recursive render, flat fallback for failed-only |
| `dashboard/src/app/activity/page.tsx` | Extend `StepRow` props: `hasChildren`, `isCollapsed`, `onToggleCollapse` |

No backend changes needed.
