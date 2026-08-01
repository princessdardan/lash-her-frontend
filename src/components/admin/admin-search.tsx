"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { ArrowRight, Search, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

import {
  searchAdminItems,
  type AdminSearchItem,
} from "@/lib/admin/admin-search";
import { cn } from "@/lib/utils";

interface AdminSearchProps {
  items: readonly AdminSearchItem[];
}

const RESULT_LIMIT = 12;

export function AdminSearch({ items }: AdminSearchProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const results = searchAdminItems(items, query, RESULT_LIMIT);
  const selectedResult = results[selectedIndex] ?? results[0];

  useEffect(() => {
    function openSearch(event: KeyboardEvent) {
      if (
        !event.defaultPrevented &&
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "k"
      ) {
        event.preventDefault();
        setOpen(true);
      }
    }

    document.addEventListener("keydown", openSearch);
    return () => document.removeEventListener("keydown", openSearch);
  }, []);

  useEffect(() => {
    if (open) {
      optionRefs.current[selectedIndex]?.scrollIntoView({ block: "nearest" });
    }
  }, [open, selectedIndex]);

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    setSelectedIndex(0);
    if (!nextOpen) {
      setQuery("");
    }
  }

  function navigateTo(item: AdminSearchItem) {
    handleOpenChange(false);
    router.push(item.href);
  }

  function handleInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((current) =>
        Math.min(current + 1, Math.max(results.length - 1, 0)),
      );
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((current) => Math.max(current - 1, 0));
      return;
    }

    if (event.key === "Enter" && selectedResult) {
      event.preventDefault();
      navigateTo(selectedResult);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Trigger asChild>
        <button
          aria-keyshortcuts="Control+K Meta+K"
          aria-label="Search admin pages and settings"
          className="inline-flex size-11 shrink-0 items-center justify-center gap-3 rounded-full border border-lh-line bg-white text-sm font-medium text-lh-shadow shadow-sm transition hover:border-lh-primary hover:bg-lh-neutral-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lh-primary focus-visible:ring-offset-2 sm:w-48 sm:justify-between sm:px-4 lg:w-64"
          type="button"
        >
          <span className="inline-flex min-w-0 items-center gap-2">
            <Search aria-hidden="true" className="size-4 shrink-0" />
            <span className="hidden truncate sm:inline">Search admin</span>
          </span>
          <kbd className="hidden rounded-md border border-lh-line bg-lh-neutral-2 px-1.5 py-0.5 font-sans text-[0.6875rem] font-semibold text-lh-muted lg:inline">
            Ctrl/⌘ K
          </kbd>
        </button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-lh-shadow/50 backdrop-blur-sm data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[min(44rem,calc(100dvh-2rem))] w-[min(44rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-3xl border border-lh-line bg-white shadow-2xl focus:outline-none"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
          }}
        >
          <div className="border-b border-lh-line px-5 pb-5 pt-6 sm:px-7 sm:pt-7">
            <div className="pr-12">
              <p className="font-smallcaps text-sm uppercase tracking-[0.18em] text-lh-muted">
                Quick navigation
              </p>
              <Dialog.Title className="mt-1 font-heading text-3xl uppercase tracking-[0.08em] text-lh-shadow sm:text-4xl">
                Find a page or setting
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-lh-muted">
                Search the admin areas available to your account.
              </Dialog.Description>
            </div>

            <div className="relative mt-5">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-lh-muted"
              />
              <label className="sr-only" htmlFor={`${listId}-input`}>
                Search admin pages and settings
              </label>
              <input
                aria-activedescendant={
                  selectedResult
                    ? `${listId}-option-${results.indexOf(selectedResult)}`
                    : undefined
                }
                aria-autocomplete="list"
                aria-controls={listId}
                aria-expanded="true"
                autoComplete="off"
                className="min-h-12 w-full rounded-2xl border border-lh-line bg-lh-neutral-2 py-3 pl-12 pr-4 text-base text-lh-shadow outline-none placeholder:text-lh-muted focus:border-lh-primary focus:ring-2 focus:ring-lh-primary/20"
                id={`${listId}-input`}
                maxLength={120}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setSelectedIndex(0);
                }}
                onKeyDown={handleInputKeyDown}
                placeholder="Try “time off”, “refunds”, or “intake questions”"
                ref={inputRef}
                role="combobox"
                spellCheck={false}
                type="search"
                value={query}
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2 sm:p-3">
            <div className="flex items-center justify-between gap-3 px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-lh-muted">
              <span>
                {query.trim() ? "Search results" : "Suggested destinations"}
              </span>
              <span aria-live="polite">
                {results.length} {results.length === 1 ? "result" : "results"}
              </span>
            </div>

            <div aria-label="Admin destinations" id={listId} role="listbox">
              {results.map((item, index) => {
                const selected = index === selectedIndex;

                return (
                  <button
                    aria-selected={selected}
                    className={cn(
                      "group flex w-full items-center gap-4 rounded-2xl px-3 py-3 text-left outline-none transition sm:px-4",
                      selected
                        ? "bg-lh-primary-soft text-lh-primary"
                        : "text-lh-shadow hover:bg-lh-neutral-2",
                    )}
                    id={`${listId}-option-${index}`}
                    key={`${item.href}-${item.label}`}
                    onClick={() => navigateTo(item)}
                    onMouseEnter={() => setSelectedIndex(index)}
                    ref={(element) => {
                      optionRefs.current[index] = element;
                    }}
                    role="option"
                    tabIndex={-1}
                    type="button"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span className="font-semibold">{item.label}</span>
                        <span className="text-xs font-semibold uppercase tracking-[0.1em] text-lh-muted">
                          {item.group}
                        </span>
                      </span>
                      <span className="mt-1 line-clamp-2 text-sm leading-5 text-lh-muted">
                        {item.description}
                      </span>
                    </span>
                    <ArrowRight
                      aria-hidden="true"
                      className="size-4 shrink-0 text-lh-muted transition-transform group-hover:translate-x-0.5"
                    />
                  </button>
                );
              })}
            </div>

            {results.length === 0 ? (
              <div className="px-4 py-12 text-center">
                <p className="font-semibold text-lh-shadow">
                  No matching page or setting
                </p>
                <p className="mt-2 text-sm text-lh-muted">
                  Try a task, workspace, integration, or setting name.
                </p>
              </div>
            ) : null}
          </div>

          <div className="border-t border-lh-line bg-lh-neutral-2 px-5 py-3 text-xs text-lh-muted sm:px-7">
            Use ↑ and ↓ to choose, then Enter to open.
          </div>

          <Dialog.Close asChild>
            <button
              aria-label="Close admin search"
              className="absolute right-4 top-4 inline-flex size-11 items-center justify-center rounded-full text-lh-muted transition hover:bg-lh-neutral-2 hover:text-lh-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lh-primary sm:right-5 sm:top-5"
              type="button"
            >
              <X aria-hidden="true" className="size-5" />
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
