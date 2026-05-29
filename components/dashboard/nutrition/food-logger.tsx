"use client";

import { useRef, useState, useTransition } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Food logging via a personal library (Nutritionix is dead — see
 * lib/claude-food-label.ts). Two flows in one Card:
 *
 *   1. Add a food from its nutrition label — type a name, snap/upload the label
 *      photo; Claude vision reads the per-serving macros + serving grams and
 *      saves it to your library.
 *   2. Log a saved food — pick it, enter grams (or servings if the label had no
 *      gram weight); macros scale linearly and post to the food-entry endpoint.
 *
 * Today's log sits below, newest-first, with per-row delete. Adds/deletes are
 * optimistic and reconcile on the server response.
 */

export type FoodEntry = {
  id: string;
  foodName: string;
  servingLabel: string | null;
  caloriesKcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  loggedAt: string;
};

export type LibraryItem = {
  id: string;
  name: string;
  servingLabel: string | null;
  servingGrams: number | null;
  caloriesKcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
};

const MAX_IMAGE_DIM = 1280;

/** Downscale an image File to a JPEG data URL so label OCR stays fast + cheap. */
async function fileToDownscaledJpeg(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Could not read the image."));
    reader.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("Could not load the image."));
    i.src = dataUrl;
  });
  const scale = Math.min(1, MAX_IMAGE_DIM / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl; // fall back to the original if canvas is unavailable
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", 0.82);
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

/** Scale a library item's per-serving macros by a logged amount. */
function scaleItem(item: LibraryItem, amount: number) {
  const factor =
    item.servingGrams && item.servingGrams > 0 ? amount / item.servingGrams : amount;
  const label =
    item.servingGrams && item.servingGrams > 0
      ? `${round1(amount)} g`
      : `${round1(amount)} × serving`;
  return {
    label,
    caloriesKcal: Math.round(item.caloriesKcal * factor),
    proteinG: round1(item.proteinG * factor),
    carbsG: round1(item.carbsG * factor),
    fatG: round1(item.fatG * factor),
  };
}

export function FoodLogger({
  todayIso,
  initialEntries,
  initialLibrary = [],
}: {
  todayIso: string;
  initialEntries: FoodEntry[];
  initialLibrary?: LibraryItem[];
}) {
  const [entries, setEntries] = useState<FoodEntry[]>(initialEntries);
  const [library, setLibrary] = useState<LibraryItem[]>(initialLibrary);

  // Which library item is expanded for logging, and the amount typed.
  const [openId, setOpenId] = useState<string | null>(null);
  const [amount, setAmount] = useState<string>("");
  const [logging, startLog] = useTransition();
  const [logError, setLogError] = useState<string | null>(null);

  // Add-from-label form.
  const [name, setName] = useState("");
  const [scanning, startScan] = useTransition();
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanNotes, setScanNotes] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const openItem = (item: LibraryItem) => {
    setLogError(null);
    if (openId === item.id) {
      setOpenId(null);
      return;
    }
    setOpenId(item.id);
    setAmount(item.servingGrams && item.servingGrams > 0 ? String(item.servingGrams) : "1");
  };

  const logItem = (item: LibraryItem) => {
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setLogError("Enter an amount greater than 0.");
      return;
    }
    const scaled = scaleItem(item, amt);
    setLogError(null);
    const optimistic: FoodEntry = {
      id: `optimistic-${item.id}-${entries.length}`,
      foodName: item.name,
      servingLabel: scaled.label,
      caloriesKcal: scaled.caloriesKcal,
      proteinG: scaled.proteinG,
      carbsG: scaled.carbsG,
      fatG: scaled.fatG,
      loggedAt: new Date().toISOString(),
    };
    setEntries((prev) => [optimistic, ...prev]);
    setOpenId(null);

    startLog(async () => {
      try {
        const res = await fetch("/api/nutrition/food-entry", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            date: todayIso,
            foodName: item.name,
            servingLabel: scaled.label,
            caloriesKcal: scaled.caloriesKcal,
            proteinG: scaled.proteinG,
            carbsG: scaled.carbsG,
            fatG: scaled.fatG,
          }),
        });
        const json = (await res.json().catch(() => null)) as
          | { ok: boolean; id?: string; message?: string }
          | null;
        if (!json?.ok) {
          setEntries((prev) => prev.filter((e) => e.id !== optimistic.id));
          setLogError(json?.message ?? "Could not log that food.");
          return;
        }
        setEntries((prev) =>
          prev.map((e) => (e.id === optimistic.id ? { ...e, id: json.id ?? e.id } : e)),
        );
      } catch (err) {
        setEntries((prev) => prev.filter((e) => e.id !== optimistic.id));
        setLogError(err instanceof Error ? err.message : "Log failed.");
      }
    });
  };

  const onDelete = (id: string) => {
    const before = entries;
    setEntries((prev) => prev.filter((e) => e.id !== id));
    fetch("/api/nutrition/food-entry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ _action: "delete", id }),
    })
      .then(async (res) => {
        const json = (await res.json().catch(() => null)) as { ok: boolean } | null;
        if (!json?.ok) setEntries(before);
      })
      .catch(() => setEntries(before));
  };

  const onScan = (e: React.FormEvent) => {
    e.preventDefault();
    setScanError(null);
    setScanNotes(null);
    const file = fileRef.current?.files?.[0];
    if (!name.trim()) {
      setScanError("Give the food a name first.");
      return;
    }
    if (!file) {
      setScanError("Choose a photo of the nutrition label.");
      return;
    }
    startScan(async () => {
      try {
        const imageBase64 = await fileToDownscaledJpeg(file);
        const res = await fetch("/api/nutrition/library", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            _action: "scan",
            name: name.trim(),
            imageBase64,
            mediaType: "image/jpeg",
          }),
        });
        const json = (await res.json().catch(() => null)) as
          | { ok: boolean; item?: LibraryItem; notes?: string; message?: string }
          | null;
        if (!json?.ok || !json.item) {
          setScanError(json?.message ?? "Could not read that label.");
          return;
        }
        const item = json.item;
        setLibrary((prev) => {
          const without = prev.filter((i) => i.id !== item.id && i.name !== item.name);
          return [item, ...without];
        });
        setScanNotes(json.notes && json.notes.length > 0 ? json.notes : "Saved to your foods.");
        setName("");
        if (fileRef.current) fileRef.current.value = "";
      } catch (err) {
        setScanError(err instanceof Error ? err.message : "Scan failed.");
      }
    });
  };

  const totalKcal = entries.reduce((a, e) => a + (e.caloriesKcal || 0), 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Log food</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Library picker */}
        <div>
          <p className="mb-2 text-[10px] font-medium tracking-wider text-stone-500 uppercase">
            Your foods
          </p>
          {library.length === 0 ? (
            <p className="rounded-xl border border-dashed border-[color:var(--color-border-subtle)] px-3 py-4 text-center text-sm text-stone-500">
              No saved foods yet. Add one from its nutrition label below ↓
            </p>
          ) : (
            <ul className="space-y-2">
              {library.map((item) => {
                const isOpen = openId === item.id;
                const amt = Number(amount);
                const preview = isOpen && Number.isFinite(amt) && amt > 0 ? scaleItem(item, amt) : null;
                const byGrams = !!(item.servingGrams && item.servingGrams > 0);
                return (
                  <li
                    key={item.id}
                    className="rounded-xl border border-[color:var(--color-border-subtle)] bg-card"
                  >
                    <div className="flex items-center gap-2 px-3 py-2.5">
                      <button
                        type="button"
                        onClick={() => openItem(item)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <div className="truncate text-sm font-medium text-stone-900">
                          {item.name}
                        </div>
                        <div className="text-[11px] text-stone-600">
                          {item.servingLabel ?? "1 serving"} ·{" "}
                          <span className="tabular-nums">{Math.round(item.caloriesKcal)} kcal</span> ·{" "}
                          <span className="tabular-nums">{Math.round(item.proteinG)}g P</span>
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteLibraryItem(item, setLibrary)}
                        aria-label={`Remove ${item.name} from your foods`}
                        className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-stone-400 transition-colors hover:bg-rose-50 hover:text-rose-600"
                      >
                        ×
                      </button>
                    </div>

                    {isOpen ? (
                      <div className="border-t border-[color:var(--color-border-subtle)] px-3 py-3">
                        <label className="block text-[11px] font-medium text-stone-600">
                          {byGrams ? "Amount (grams)" : "Servings"}
                          <input
                            type="number"
                            inputMode="decimal"
                            step={byGrams ? "1" : "0.5"}
                            min="0"
                            value={amount}
                            autoFocus
                            onChange={(e) => setAmount(e.target.value)}
                            className="mt-1 h-10 w-full rounded-xl border border-amber-950/15 bg-card px-3 text-sm text-stone-900 outline-none focus:border-orange-500/40 focus:ring-2 focus:ring-orange-500/25"
                          />
                        </label>
                        {preview ? (
                          <div className="mt-2 text-[11px] text-stone-600">
                            <span className="tabular-nums font-medium text-stone-800">
                              {preview.caloriesKcal} kcal
                            </span>{" "}
                            ·{" "}
                            <span className="tabular-nums">{preview.proteinG}g P</span> ·{" "}
                            <span className="tabular-nums">{preview.carbsG}g C</span> ·{" "}
                            <span className="tabular-nums">{preview.fatG}g F</span>
                          </div>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => logItem(item)}
                          disabled={logging}
                          className="mt-3 inline-flex h-9 items-center justify-center rounded-xl bg-[color:var(--ui-accent)] px-3 text-sm font-medium text-[color:var(--color-text-inverse)] hover:bg-[color:color-mix(in_srgb,var(--ui-accent)_88%,#000)] disabled:opacity-50"
                        >
                          Log to today
                        </button>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          {logError ? (
            <p className="mt-2 text-sm text-[color:var(--ui-danger)]">{logError}</p>
          ) : null}
        </div>

        {/* Add a food from its label */}
        <details className="rounded-xl border border-[color:var(--color-border-subtle)] bg-card/60">
          <summary className="cursor-pointer px-3 py-2.5 text-sm font-medium text-stone-700">
            + Add a food from its label
          </summary>
          <form onSubmit={onScan} className="space-y-3 px-3 pb-3">
            <label className="block">
              <div className="text-[10px] font-medium tracking-wider text-stone-500 uppercase">
                Food name
              </div>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Trader Joe's Chicken"
                className="mt-1 h-10 w-full rounded-xl border border-amber-950/15 bg-card px-3 text-sm text-stone-900 outline-none focus:border-orange-500/40 focus:ring-2 focus:ring-orange-500/25"
              />
            </label>
            <label className="block">
              <div className="text-[10px] font-medium tracking-wider text-stone-500 uppercase">
                Nutrition label photo
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="mt-1 block w-full text-sm text-stone-700 file:mr-3 file:rounded-lg file:border-0 file:bg-stone-900 file:px-3 file:py-2 file:text-xs file:font-medium file:text-white hover:file:bg-stone-800"
              />
            </label>
            <button
              type="submit"
              disabled={scanning}
              className="inline-flex h-10 items-center justify-center rounded-xl bg-stone-900 px-4 text-sm font-medium text-white transition-colors hover:bg-stone-800 disabled:opacity-50"
            >
              {scanning ? "Reading label…" : "Scan label"}
            </button>
            {scanError ? (
              <p className="text-sm text-[color:var(--ui-danger)]">{scanError}</p>
            ) : null}
            {scanNotes ? <p className="text-xs text-stone-500">{scanNotes}</p> : null}
          </form>
        </details>

        {/* Today's log */}
        <div>
          <div className="mb-2 flex items-baseline justify-between">
            <h4 className="text-xs font-semibold tracking-wider text-stone-600 uppercase">
              Today
            </h4>
            <span className="text-[11px] tabular-nums text-stone-500">
              {entries.length === 0
                ? "0 entries"
                : `${entries.length} ${entries.length === 1 ? "entry" : "entries"} · ${Math.round(totalKcal)} kcal`}
            </span>
          </div>
          {entries.length === 0 ? (
            <p className="rounded-xl border border-dashed border-[color:var(--color-border-subtle)] px-3 py-4 text-center text-sm text-stone-500">
              No foods logged today ↑ pick one from your foods above.
            </p>
          ) : (
            <ul className="divide-y divide-[color:var(--color-border-subtle)]">
              {entries.map((e) => (
                <li key={e.id} className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-stone-900">
                      {e.foodName}
                    </div>
                    <div className="text-[11px] text-stone-600">
                      {e.servingLabel ? `${e.servingLabel} · ` : ""}
                      <span className="tabular-nums">{Math.round(e.caloriesKcal)} kcal</span> ·{" "}
                      <span className="tabular-nums">{Math.round(e.proteinG)}g P</span> ·{" "}
                      <span className="tabular-nums">{Math.round(e.carbsG)}g C</span> ·{" "}
                      <span className="tabular-nums">{Math.round(e.fatG)}g F</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onDelete(e.id)}
                    aria-label={`Delete ${e.foodName}`}
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-stone-400 transition-colors hover:bg-rose-50 hover:text-rose-600"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** Delete a library item (best-effort optimistic removal). */
function deleteLibraryItem(
  item: LibraryItem,
  setLibrary: React.Dispatch<React.SetStateAction<LibraryItem[]>>,
) {
  setLibrary((prev) => prev.filter((i) => i.id !== item.id));
  fetch("/api/nutrition/library", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ _action: "delete", id: item.id }),
  }).catch(() => {
    // Re-add on failure.
    setLibrary((prev) => (prev.some((i) => i.id === item.id) ? prev : [item, ...prev]));
  });
}
