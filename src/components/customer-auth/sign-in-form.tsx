"use client";

import { useEffect, useState } from "react";

export function CustomerSignInForm({ returnTo, signedIn = false }: { returnTo: string; signedIn?: boolean }) {
  const [csrfToken, setCsrfToken] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/customer-auth/csrf", { cache: "no-store", credentials: "same-origin", signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error();
        const body: unknown = await response.json();
        if (!body || typeof body !== "object" || !("csrfToken" in body) || typeof body.csrfToken !== "string" || !body.csrfToken) throw new Error();
        setCsrfToken(body.csrfToken);
      }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, []);
  const fields = <><input type="hidden" name="csrfToken" value={csrfToken} /><input type="hidden" name="callbackUrl" value={returnTo} /></>;
  const buttonClass = "w-full border border-current px-5 py-3 text-sm tracking-wide transition-opacity disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4";
  return <div className="space-y-6">
    {failed && <p role="alert">Sign-in is temporarily unavailable. Please reload this page to retry.</p>}
    <form action="/api/customer-auth/signin/google" method="post">
      {fields}<button className={buttonClass} disabled={!csrfToken} type="submit">{signedIn ? "Link Google account" : "Continue with Google"}</button>
    </form>
    {!signedIn && <form action="/api/customer-auth/signin/resend" method="post" className="space-y-3">
      {fields}
      <label htmlFor="customer-email" className="block text-sm">Email address</label>
      <input id="customer-email" name="email" type="email" autoComplete="email" maxLength={254} required className="w-full border border-current/30 bg-transparent px-4 py-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" />
      <button className={buttonClass} disabled={!csrfToken} type="submit">Email a sign-in link</button>
      <p className="text-sm opacity-70">The link expires in 15 minutes and can be used once. Signing in does not subscribe you to marketing emails.</p>
    </form>}
    {signedIn && <form action="/api/customer-auth/signout" method="post">
      <input type="hidden" name="csrfToken" value={csrfToken} /><input type="hidden" name="callbackUrl" value="/sign-in" />
      <button className={buttonClass} disabled={!csrfToken} type="submit">Sign out</button>
    </form>}
  </div>;
}
