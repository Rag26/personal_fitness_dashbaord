"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, X } from "lucide-react";

import {
  MUSCLE_GROUP_OPTIONS,
  muscleGroupLabel,
} from "@/lib/hevy-muscle-groups";

type Target = { muscleGroup: string; target: number };
type Row = { id: string; muscleGroup: string; target: string };

let _rid = 0;
const nextId = () => `r${++_rid}`;

function toRows(initial: readonly Target[]): Row[] {
  if (initial.length === 0) {
    // Empty defaults: 3 blank rows so the user has somewhere to type.
    return [
      { id: nextId(), muscleGroup: "", target: "" },
      { id: nextId(), muscleGroup: "", target: "" },
      { id: nextId(), muscleGroup: "", target: "" },
    ];
  }
  return initial.map((t) => ({
    id: nextId(),
    muscleGroup: t.muscleGroup,
    target: String(t.target),
  }));
}

export function MuscleGroupGoalsClient({
  initialTargets,
}: {
  initialTargets: readonly Target[];
}) {
  const router = useRouter();
  const [rows, setRows] = React.useState<Row[]>(() => toRows(initialTargets));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setRows(toRows(initialTargets));
  }, [initialTargets]);

  function updateRow(id: string, patch: Partial<Row>) {
    setRows((cur) => cur.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }
  function removeRow(id: string) {
    setRows((cur) => cur.filter((r) => r.id !== id));
  }
  function addRow() {
    setRows((cur) => [...cur, { id: nextId(), muscleGroup: "", target: "" }]);
  }

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const parsed: Target[] = [];
      const seen = new Set<string>();
      for (const r of rows) {
        const group = r.muscleGroup.trim().toLowerCase();
        if (!group) continue;
        if (seen.has(group)) continue;
        seen.add(group);
        const n = Number(r.target);
        const target =
          Number.isFinite(n) && n >= 0 ? Math.min(14, Math.round(n)) : 0;
        parsed.push({ muscleGroup: group, target });
      }
      const res = await fetch("/api/muscle-group-targets", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targets: parsed }),
      });
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string }
        | null;
      if (!res.ok || !json?.ok) {
        throw new Error(json?.error ?? `Failed (${res.status})`);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save targets");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 px-6 pb-6">
      {error ? (
        <div className="rounded-xl border border-[color:color-mix(in_srgb,var(--ui-danger)_35%,transparent)] bg-[color:var(--ui-danger-soft)] px-3 py-2 text-sm text-[color:color-mix(in_srgb,var(--ui-danger)_72%,var(--color-text-primary))]">
          {error}
        </div>
      ) : null}
      <p className="text-xs text-stone-500">
        Per-muscle-group weekly session targets. A single workout counts toward
        every muscle group it hits (so a push day with overhead press ticks
        both push and shoulders). Saved separately from the split plan above.
      </p>
      <form onSubmit={onSave} className="space-y-2">
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.id} className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1 text-xs text-stone-500">
                <span>Muscle group</span>
                <select
                  value={r.muscleGroup}
                  onChange={(e) =>
                    updateRow(r.id, { muscleGroup: e.target.value })
                  }
                  className="h-9 w-44 rounded-lg border border-[color:var(--color-border-default)] bg-card px-2 text-sm text-[color:var(--color-text-primary)] outline-none focus:border-[color:var(--ui-accent)] focus:ring-2 focus:ring-[color:var(--ring)]"
                >
                  <option value="">—</option>
                  {MUSCLE_GROUP_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                  {r.muscleGroup &&
                  !MUSCLE_GROUP_OPTIONS.some(
                    (o) => o.value === r.muscleGroup,
                  ) ? (
                    <option value={r.muscleGroup}>
                      {muscleGroupLabel(r.muscleGroup)}
                    </option>
                  ) : null}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-stone-500">
                <span>Per week</span>
                <input
                  type="number"
                  min={0}
                  max={14}
                  value={r.target}
                  onChange={(e) => updateRow(r.id, { target: e.target.value })}
                  className="h-9 w-20 rounded-lg border border-[color:var(--color-border-default)] bg-card px-2 text-sm text-[color:var(--color-text-primary)] outline-none focus:border-[color:var(--ui-accent)] focus:ring-2 focus:ring-[color:var(--ring)]"
                />
              </label>
              <button
                type="button"
                aria-label="Remove row"
                onClick={() => removeRow(r.id)}
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[color:var(--color-border-subtle)] text-stone-500 hover:bg-[color:var(--ui-accent-soft)] hover:text-[color:var(--color-text-primary)]"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-2 pt-1">
          <button
            type="button"
            onClick={addRow}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[color:var(--color-border-default)] bg-card px-3 text-xs font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--ui-accent-soft)]"
          >
            <Plus className="h-3.5 w-3.5" />
            Add muscle group
          </button>
          <button
            type="submit"
            disabled={busy}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[color:var(--ui-accent)] px-3 text-xs font-medium text-[color:var(--color-text-inverse)] hover:bg-[color:color-mix(in_srgb,var(--ui-accent)_88%,black)] disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Save targets
          </button>
        </div>
      </form>
    </div>
  );
}
