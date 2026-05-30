"use client";

import * as React from "react";

const GOOGLE_SCHEDULING_BUTTON_CSS = "https://calendar.google.com/calendar/scheduling-button-script.css";
const GOOGLE_SCHEDULING_BUTTON_SCRIPT = "https://calendar.google.com/calendar/scheduling-button-script.js";
const GOOGLE_SCHEDULING_BUTTON_COLOR = "#663976";
const MOBILE_SCHEDULE_BUTTON_MEDIA_QUERY = "(max-width: 767px)";

type GoogleSchedulingButtonLoadOptions = {
  url: string;
  color: string;
  label: string;
  target: HTMLElement;
};

type GoogleSchedulingButton = {
  load: (options: GoogleSchedulingButtonLoadOptions) => void;
};

declare global {
  interface Window {
    calendar?: {
      schedulingButton?: GoogleSchedulingButton;
    };
  }
}

let schedulingButtonScriptPromise: Promise<void> | null = null;

interface GoogleAppointmentSchedulePopupButtonProps {
  scheduleUrl: string;
  label: string;
}

export function GoogleAppointmentSchedulePopupButton({
  label,
  scheduleUrl,
}: GoogleAppointmentSchedulePopupButtonProps) {
  const buttonTargetRef = React.useRef<HTMLDivElement>(null);
  const [isGoogleButtonReady, setIsGoogleButtonReady] = React.useState(false);
  const [isMobileViewport, setIsMobileViewport] = React.useState(false);

  React.useEffect(() => {
    const mediaQuery = window.matchMedia(MOBILE_SCHEDULE_BUTTON_MEDIA_QUERY);
    const syncViewportState = () => {
      const isMobile = mediaQuery.matches;
      setIsMobileViewport(isMobile);
      if (!isMobile) {
        setIsGoogleButtonReady(false);
      }
    };

    syncViewportState();
    mediaQuery.addEventListener("change", syncViewportState);

    return () => mediaQuery.removeEventListener("change", syncViewportState);
  }, []);

  React.useEffect(() => {
    if (!isMobileViewport) {
      buttonTargetRef.current?.replaceChildren();
      return;
    }

    let isMounted = true;

    ensureGoogleSchedulingAssets()
      .then(() => {
        const target = buttonTargetRef.current;
        const schedulingButton = window.calendar?.schedulingButton;

        if (!isMounted || !target || !schedulingButton) return;

        target.replaceChildren();
        schedulingButton.load({
          color: GOOGLE_SCHEDULING_BUTTON_COLOR,
          label,
          target,
          url: scheduleUrl,
        });
        setIsGoogleButtonReady(true);
      })
      .catch(() => {
        if (isMounted) {
          setIsGoogleButtonReady(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [isMobileViewport, label, scheduleUrl]);

  return (
    <div className="flex flex-col items-center gap-4">
      <div
        ref={buttonTargetRef}
        className={isGoogleButtonReady ? "flex justify-center" : "hidden"}
      />
      {!isGoogleButtonReady ? (
        <a
          href={scheduleUrl}
          className="inline-flex items-center justify-center rounded-full bg-lh-primary px-7 py-4 font-body text-sm font-bold uppercase tracking-[0.12em] text-lh-white transition-colors hover:bg-lh-accent"
          target="_blank"
          rel="noopener noreferrer"
        >
          {label}
        </a>
      ) : null}
    </div>
  );
}

function ensureGoogleSchedulingAssets(): Promise<void> {
  ensureGoogleSchedulingStylesheet();

  if (window.calendar?.schedulingButton) {
    return Promise.resolve();
  }

  if (schedulingButtonScriptPromise) {
    return schedulingButtonScriptPromise;
  }

  schedulingButtonScriptPromise = new Promise((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>(
      `script[src="${GOOGLE_SCHEDULING_BUTTON_SCRIPT}"]`
    );

    if (existingScript) {
      existingScript.addEventListener("load", () => resolve(), { once: true });
      existingScript.addEventListener("error", reject, { once: true });
      return;
    }

    const script = document.createElement("script");
    script.async = true;
    script.src = GOOGLE_SCHEDULING_BUTTON_SCRIPT;
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", reject, { once: true });
    document.head.append(script);
  });

  return schedulingButtonScriptPromise;
}

function ensureGoogleSchedulingStylesheet() {
  const existingStylesheet = document.querySelector<HTMLLinkElement>(
    `link[href="${GOOGLE_SCHEDULING_BUTTON_CSS}"]`
  );

  if (existingStylesheet) return;

  const stylesheet = document.createElement("link");
  stylesheet.href = GOOGLE_SCHEDULING_BUTTON_CSS;
  stylesheet.rel = "stylesheet";
  document.head.append(stylesheet);
}
