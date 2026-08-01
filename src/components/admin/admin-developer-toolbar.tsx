"use client";

import { usePathname } from "next/navigation";

import { setAdminDeveloperSessionAction } from "@/app/admin/auth-actions";
import type { AdminDeveloperUserOption } from "@/lib/admin/developer-mode-config";
import type { AdminActor } from "@/lib/admin/types";

interface AdminDeveloperToolbarProps {
  actor: AdminActor;
  users: AdminDeveloperUserOption[];
}

export function AdminDeveloperToolbar({
  actor,
  users,
}: AdminDeveloperToolbarProps) {
  const pathname = usePathname();
  if (!actor.developerMode) return null;

  return (
    <form
      action={setAdminDeveloperSessionAction}
      className="border-b-2 border-amber-500 bg-amber-50 px-5 py-3 text-amber-950 md:px-8"
    >
      <input type="hidden" name="returnTo" value={pathname} />
      <div className="mx-auto flex max-w-5xl flex-wrap items-end justify-center gap-3">
        <p className="self-center text-sm font-semibold uppercase tracking-[0.12em]">
          Developer mode
        </p>
        <label className="text-xs font-semibold">
          Represented account
          <select
            className="mt-1 block min-h-10 max-w-72 rounded-lg border border-amber-400 bg-white px-3 py-1.5 text-sm font-normal text-lh-shadow"
            defaultValue={actor.user.id}
            name="actingAdminUserId"
          >
            {users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.displayName ?? user.email}
                {user.status === "disabled" ? " (disabled)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-semibold">
          Permissions
          <select
            className="mt-1 block min-h-10 rounded-lg border border-amber-400 bg-white px-3 py-1.5 text-sm font-normal text-lh-shadow"
            defaultValue={actor.developerMode.permissionRole}
            name="permissionRole"
          >
            <option value="owner">Owner</option>
            <option value="admin">Administrator</option>
            <option value="employee">Contractor</option>
          </select>
        </label>
        <button
          className="min-h-10 rounded-lg bg-amber-950 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-900"
          type="submit"
        >
          Apply
        </button>
      </div>
    </form>
  );
}
