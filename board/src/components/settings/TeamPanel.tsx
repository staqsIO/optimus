"use client";

import { useState, type Dispatch, type SetStateAction } from "react";
import { opsPost, opsPatch, opsDelete } from "@/lib/ops-api";

export interface BoardMember {
  id: string;
  github_username: string;
  display_name: string;
  email: string | null;
  role: string;
  is_active: boolean;
  created_at: string;
}

type EditableField = "display_name" | "github_username" | "email";

type RowEdit =
  | { kind: "idle" }
  | { kind: "editing"; field: EditableField; value: string; saving: boolean };

interface AddForm {
  display_name: string;
  github_username: string;
  email: string;
  role: "admin" | "member" | "external_agent";
}

const EMPTY_ADD_FORM: AddForm = {
  display_name: "",
  github_username: "",
  email: "",
  role: "member",
};

interface Props {
  members: BoardMember[];
  setMembers: Dispatch<SetStateAction<BoardMember[]>>;
  currentUsername: string | null;
  isAdmin: boolean;
}

export default function TeamPanel({ members, setMembers, currentUsername, isAdmin }: Props) {
  const [rowEdits, setRowEdits] = useState<Record<string, RowEdit>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [roleUpdating, setRoleUpdating] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<BoardMember | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<AddForm>(EMPTY_ADD_FORM);
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  if (!isAdmin || members.length === 0) return null;

  const getEdit = (id: string): RowEdit => rowEdits[id] ?? { kind: "idle" };

  const startEdit = (member: BoardMember, field: EditableField) => {
    if (member.github_username === currentUsername && field === "github_username") return;
    const initial =
      field === "display_name"
        ? member.display_name
        : field === "github_username"
          ? member.github_username
          : member.email ?? "";
    setRowEdits((prev) => ({ ...prev, [member.id]: { kind: "editing", field, value: initial, saving: false } }));
    setRowError((prev) => ({ ...prev, [member.id]: "" }));
  };

  const cancelEdit = (id: string) => {
    setRowEdits((prev) => ({ ...prev, [id]: { kind: "idle" } }));
  };

  const updateEditValue = (id: string, value: string) => {
    setRowEdits((prev) => {
      const cur = prev[id];
      if (!cur || cur.kind !== "editing") return prev;
      return { ...prev, [id]: { ...cur, value } };
    });
  };

  const saveEdit = async (member: BoardMember) => {
    const edit = getEdit(member.id);
    if (edit.kind !== "editing") return;
    const trimmed = edit.value.trim();

    const currentValue =
      edit.field === "display_name"
        ? member.display_name
        : edit.field === "github_username"
          ? member.github_username
          : member.email ?? "";
    if (trimmed === currentValue.trim()) {
      cancelEdit(member.id);
      return;
    }
    if (edit.field !== "email" && trimmed.length === 0) {
      setRowError((prev) => ({ ...prev, [member.id]: "Cannot be empty" }));
      return;
    }

    setRowEdits((prev) => ({ ...prev, [member.id]: { ...edit, saving: true } }));
    const payload: Partial<Record<EditableField, string | null>> = {
      [edit.field]: edit.field === "email" ? (trimmed.length === 0 ? null : trimmed) : trimmed,
    };
    const res = await opsPatch<{ ok: true; member: BoardMember }>(
      `/api/board-members/${member.id}`,
      payload
    );
    if (!res.ok) {
      setRowError((prev) => ({ ...prev, [member.id]: res.error }));
      setRowEdits((prev) => ({ ...prev, [member.id]: { ...edit, saving: false } }));
      return;
    }
    setMembers((prev) => prev.map((m) => (m.id === member.id ? res.data.member : m)));
    setRowEdits((prev) => ({ ...prev, [member.id]: { kind: "idle" } }));
    setRowError((prev) => ({ ...prev, [member.id]: "" }));
  };

  const changeRole = async (member: BoardMember, newRole: string) => {
    setRoleUpdating(member.id);
    const res = await opsPost<{ ok: true }>("/api/board-members/role", {
      memberId: member.id,
      role: newRole,
    });
    if (res.ok) {
      setMembers((prev) => prev.map((m) => (m.id === member.id ? { ...m, role: newRole } : m)));
    } else {
      setRowError((prev) => ({ ...prev, [member.id]: res.error }));
    }
    setRoleUpdating(null);
  };

  const handleRemove = async (member: BoardMember) => {
    setRemoving(member.id);
    const res = await opsDelete<{ ok: true }>(`/api/board-members/${member.id}`);
    if (res.ok) {
      setMembers((prev) => prev.filter((m) => m.id !== member.id));
      setConfirmRemove(null);
    } else {
      setRowError((prev) => ({ ...prev, [member.id]: res.error }));
    }
    setRemoving(null);
  };

  const handleAdd = async () => {
    setAddError(null);
    const display_name = addForm.display_name.trim();
    const github_username = addForm.github_username.trim().replace(/^@/, "");
    const email = addForm.email.trim();
    if (!display_name || !github_username) {
      setAddError("Display name and GitHub username are required");
      return;
    }
    setAdding(true);
    const res = await opsPost<{ ok: true; member: BoardMember }>("/api/board-members", {
      display_name,
      github_username,
      email: email || null,
      role: addForm.role,
    });
    if (!res.ok) {
      setAddError(res.error);
      setAdding(false);
      return;
    }
    setMembers((prev) => {
      const without = prev.filter((m) => m.id !== res.data.member.id);
      return [...without, res.data.member];
    });
    setAddForm(EMPTY_ADD_FORM);
    setAddOpen(false);
    setAdding(false);
  };

  return (
    <div className="bg-surface-raised rounded-lg border border-white/5 p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Team</h2>
        <button
          type="button"
          onClick={() => {
            setAddOpen((v) => !v);
            setAddError(null);
          }}
          className="text-xs px-2.5 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700 border border-white/10 text-zinc-200"
        >
          {addOpen ? "Cancel" : "+ Add member"}
        </button>
      </div>
      <p className="text-sm text-zinc-400 mb-4">
        Manage board member roles and details. Click any field to edit. Admins have full access; members see a filtered view.
      </p>

      {addOpen && (
        <div className="mb-4 p-4 rounded-lg bg-zinc-900/70 border border-white/10 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-[11px] uppercase tracking-wide text-zinc-500">Display name</span>
              <input
                type="text"
                value={addForm.display_name}
                onChange={(e) => setAddForm({ ...addForm, display_name: e.target.value })}
                placeholder="Jane Doe"
                className="mt-1 w-full bg-zinc-800 border border-white/10 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-white/30"
              />
            </label>
            <label className="block">
              <span className="text-[11px] uppercase tracking-wide text-zinc-500">GitHub username</span>
              <input
                type="text"
                value={addForm.github_username}
                onChange={(e) => setAddForm({ ...addForm, github_username: e.target.value })}
                placeholder="janedoe"
                className="mt-1 w-full bg-zinc-800 border border-white/10 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-white/30"
              />
            </label>
            <label className="block">
              <span className="text-[11px] uppercase tracking-wide text-zinc-500">Email</span>
              <input
                type="email"
                value={addForm.email}
                onChange={(e) => setAddForm({ ...addForm, email: e.target.value })}
                placeholder="jane@example.com"
                className="mt-1 w-full bg-zinc-800 border border-white/10 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-white/30"
              />
            </label>
            <label className="block">
              <span className="text-[11px] uppercase tracking-wide text-zinc-500">Role</span>
              <select
                value={addForm.role}
                onChange={(e) => setAddForm({ ...addForm, role: e.target.value as AddForm["role"] })}
                className="mt-1 w-full bg-zinc-800 border border-white/10 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-white/30"
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
                <option value="external_agent">External Agent</option>
              </select>
            </label>
          </div>
          {addError && <div className="text-xs text-red-400">{addError}</div>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setAddOpen(false);
                setAddForm(EMPTY_ADD_FORM);
                setAddError(null);
              }}
              className="text-xs px-3 py-1.5 rounded-md text-zinc-400 hover:text-zinc-200"
              disabled={adding}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleAdd}
              disabled={adding}
              className="text-xs px-3 py-1.5 rounded-md bg-emerald-700/40 hover:bg-emerald-700/60 border border-emerald-600/40 text-emerald-100 disabled:opacity-50"
            >
              {adding ? "Adding…" : "Add member"}
            </button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {members.map((member) => {
          const edit = getEdit(member.id);
          const isSelf = member.github_username === currentUsername;
          const isExternal = member.role === "external_agent";
          const error = rowError[member.id];

          return (
            <div
              key={member.id}
              className="px-3 py-2 rounded-lg bg-zinc-900/50 border border-white/5"
            >
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0 space-y-0.5">
                  <div className="text-sm font-medium text-zinc-200 flex items-center gap-2">
                    {edit.kind === "editing" && edit.field === "display_name" ? (
                      <input
                        autoFocus
                        type="text"
                        value={edit.value}
                        disabled={edit.saving}
                        onChange={(e) => updateEditValue(member.id, e.target.value)}
                        onBlur={() => saveEdit(member)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveEdit(member);
                          if (e.key === "Escape") cancelEdit(member.id);
                        }}
                        className="bg-zinc-800 border border-white/20 rounded px-1.5 py-0.5 text-sm w-64 focus:outline-none focus:border-white/40"
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => startEdit(member, "display_name")}
                        className="text-left hover:text-white"
                        title="Click to edit"
                      >
                        {member.display_name || member.github_username}
                      </button>
                    )}
                    {isSelf && <span className="text-[10px] text-zinc-500">(you)</span>}
                  </div>
                  <div className="text-xs text-zinc-500 flex items-center gap-2 flex-wrap">
                    {edit.kind === "editing" && edit.field === "github_username" ? (
                      <input
                        autoFocus
                        type="text"
                        value={edit.value}
                        disabled={edit.saving}
                        onChange={(e) => updateEditValue(member.id, e.target.value)}
                        onBlur={() => saveEdit(member)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveEdit(member);
                          if (e.key === "Escape") cancelEdit(member.id);
                        }}
                        className="bg-zinc-800 border border-white/20 rounded px-1.5 py-0.5 text-xs w-48 focus:outline-none focus:border-white/40"
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => !isSelf && startEdit(member, "github_username")}
                        className={`hover:text-zinc-300 ${isSelf ? "cursor-default" : ""}`}
                        disabled={isSelf}
                        title={isSelf ? "" : "Click to edit"}
                      >
                        @{member.github_username}
                      </button>
                    )}
                    {edit.kind === "editing" && edit.field === "email" ? (
                      <input
                        autoFocus
                        type="email"
                        value={edit.value}
                        disabled={edit.saving}
                        onChange={(e) => updateEditValue(member.id, e.target.value)}
                        onBlur={() => saveEdit(member)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveEdit(member);
                          if (e.key === "Escape") cancelEdit(member.id);
                        }}
                        placeholder="email@example.com"
                        className="bg-zinc-800 border border-white/20 rounded px-1.5 py-0.5 text-xs w-64 focus:outline-none focus:border-white/40"
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => startEdit(member, "email")}
                        className="hover:text-zinc-300"
                        title="Click to edit"
                      >
                        {member.email ?? <span className="italic text-zinc-600">add email</span>}
                      </button>
                    )}
                  </div>
                </div>
                <select
                  value={member.role}
                  disabled={roleUpdating === member.id || isSelf}
                  onChange={(e) => changeRole(member, e.target.value)}
                  className={`bg-zinc-800 border border-white/10 rounded px-2 py-1 text-xs focus:outline-none focus:border-white/20 ${
                    member.role === "admin"
                      ? "text-amber-300"
                      : member.role === "external_agent"
                        ? "text-teal-300"
                        : "text-zinc-300"
                  } ${isSelf ? "opacity-50 cursor-not-allowed" : ""}`}
                >
                  <option value="admin">Admin</option>
                  <option value="member">Member</option>
                  <option value="external_agent">External Agent</option>
                </select>
                {!isSelf && !isExternal && (
                  <button
                    type="button"
                    onClick={() => setConfirmRemove(member)}
                    className="text-xs text-zinc-500 hover:text-red-400 px-2 py-1"
                    title="Remove member"
                  >
                    Remove
                  </button>
                )}
              </div>
              {error && <div className="text-xs text-red-400 mt-1.5">{error}</div>}
            </div>
          );
        })}
      </div>

      {confirmRemove && (
        <div
          className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
          onClick={() => removing == null && setConfirmRemove(null)}
        >
          <div
            className="bg-zinc-900 border border-white/10 rounded-lg p-5 max-w-sm w-full space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div>
              <h3 className="text-base font-semibold text-zinc-100">Remove team member</h3>
              <p className="text-sm text-zinc-400 mt-1">
                Remove <span className="text-zinc-200">{confirmRemove.display_name}</span> (@
                {confirmRemove.github_username})? This deactivates the account; data is retained.
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmRemove(null)}
                disabled={removing != null}
                className="text-xs px-3 py-1.5 rounded-md text-zinc-400 hover:text-zinc-200"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => handleRemove(confirmRemove)}
                disabled={removing != null}
                className="text-xs px-3 py-1.5 rounded-md bg-red-900/40 hover:bg-red-900/60 border border-red-700/40 text-red-200 disabled:opacity-50"
              >
                {removing != null ? "Removing…" : "Remove"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
