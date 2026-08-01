"use client";

import type { DragEvent, ReactNode } from "react";
import { useState } from "react";
import { ArrowDown, ArrowUp, GripVertical, LoaderCircle } from "lucide-react";

import { moveSortableItem } from "./sortable-service-order";

interface SortableServiceItem {
  content: ReactNode;
  id: string;
  label: string;
}

interface SortableServiceListProps {
  action: (offeringIds: string[]) => Promise<{ error?: string }>;
  items: SortableServiceItem[];
}

export function SortableServiceList({
  action,
  items: initialItems,
}: SortableServiceListProps) {
  const [orderedIds, setOrderedIds] = useState(() =>
    initialItems.map((item) => item.id),
  );
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [status, setStatus] = useState("");
  const itemById = new Map(initialItems.map((item) => [item.id, item]));
  const items = orderedIds.flatMap((id) => {
    const item = itemById.get(id);
    return item ? [item] : [];
  });

  async function move(fromIndex: number, toIndex: number) {
    if (isSaving || fromIndex === toIndex) return;
    const previousIds = orderedIds;
    const nextIds = moveSortableItem(orderedIds, fromIndex, toIndex);
    if (nextIds === orderedIds) return;

    setOrderedIds(nextIds);
    setIsSaving(true);
    setStatus("Saving display order…");
    try {
      const result = await action(nextIds);
      if (result.error) {
        setOrderedIds(previousIds);
        setStatus(result.error);
      } else {
        setStatus("Display order saved.");
      }
    } catch {
      setOrderedIds(previousIds);
      setStatus("The display order could not be saved. Try again.");
    } finally {
      setIsSaving(false);
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>, targetId: string) {
    event.preventDefault();
    const sourceId = draggedId ?? event.dataTransfer.getData("text/plain");
    setDraggedId(null);
    void move(
      items.findIndex((item) => item.id === sourceId),
      items.findIndex((item) => item.id === targetId),
    );
  }

  return (
    <div>
      <p className="mb-4 text-sm text-lh-muted">
        Drag services into the client-facing order, or use the arrow buttons.
        Changes save automatically.
      </p>
      <div className="grid gap-4 xl:grid-cols-2">
        {items.map((item, index) => (
          <div
            className={`relative rounded-2xl transition ${
              draggedId === item.id ? "opacity-50" : "opacity-100"
            }`}
            key={item.id}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => handleDrop(event, item.id)}
          >
            <div className="absolute right-4 top-4 z-10 flex items-center gap-1 rounded-full border border-lh-line bg-white p-1 shadow-sm">
              <button
                aria-label={`Drag ${item.label} to reorder`}
                className="flex size-9 cursor-grab items-center justify-center rounded-full text-lh-muted hover:bg-lh-neutral-2 active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-40"
                disabled={isSaving}
                draggable={!isSaving}
                onDragEnd={() => setDraggedId(null)}
                onDragStart={(event) => {
                  setDraggedId(item.id);
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", item.id);
                }}
                type="button"
              >
                <GripVertical aria-hidden="true" className="size-4" />
              </button>
              <button
                aria-label={`Move ${item.label} up`}
                className="flex size-9 items-center justify-center rounded-full text-lh-muted hover:bg-lh-neutral-2 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={isSaving || index === 0}
                onClick={() => void move(index, index - 1)}
                type="button"
              >
                <ArrowUp aria-hidden="true" className="size-4" />
              </button>
              <button
                aria-label={`Move ${item.label} down`}
                className="flex size-9 items-center justify-center rounded-full text-lh-muted hover:bg-lh-neutral-2 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={isSaving || index === items.length - 1}
                onClick={() => void move(index, index + 1)}
                type="button"
              >
                <ArrowDown aria-hidden="true" className="size-4" />
              </button>
            </div>
            {item.content}
          </div>
        ))}
      </div>
      <p
        aria-live="polite"
        className="mt-3 flex min-h-5 items-center gap-2 text-xs text-lh-muted"
        role="status"
      >
        {isSaving ? (
          <LoaderCircle aria-hidden="true" className="size-3 animate-spin" />
        ) : null}
        {status}
      </p>
    </div>
  );
}
