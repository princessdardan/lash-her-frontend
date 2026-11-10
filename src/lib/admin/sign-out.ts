export async function completeAdminSignOut(dependencies: {
  hasDeveloperSession: () => Promise<boolean>;
  clearDeveloperSession: () => Promise<unknown>;
  signOut: () => Promise<unknown>;
}): Promise<string> {
  const hadDeveloperSession = await dependencies.hasDeveloperSession();
  await dependencies.clearDeveloperSession();
  if (!hadDeveloperSession) await dependencies.signOut();
  // Auth.js signOut({ redirect: false }) returns a raw response. This fixed
  // destination remains a string regardless of that provider helper's shape.
  return "/admin/sign-in";
}
