"use client";

import { useEffect, useRef, useState } from "react";
import type Quill from "quill";

import "quill/dist/quill.snow.css";

import {
  saveCampaignDraftAction,
  sendCampaignAction,
  sendCampaignTestAction,
} from "@/app/admin/(protected)/marketing/campaigns/actions";

type Feedback = { tone: "success" | "error" | "info"; message: string } | null;

interface CampaignComposerProps {
  optedInCount: number;
}

const TOOLBAR = [
  [{ header: [2, 3, false] }],
  ["bold", "italic", "underline"],
  [{ list: "ordered" }, { list: "bullet" }],
  ["blockquote", "link"],
  ["clean"],
];

export function CampaignComposer({ optedInCount }: CampaignComposerProps) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const quillRef = useRef<Quill | null>(null);
  const [editorReady, setEditorReady] = useState(false);

  const [subject, setSubject] = useState("");
  const [previewText, setPreviewText] = useState("");
  const [campaignId, setCampaignId] = useState<string | undefined>(undefined);

  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduledAtLocal, setScheduledAtLocal] = useState("");

  const [busy, setBusy] = useState<null | "save" | "test" | "send">(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  useEffect(() => {
    let cancelled = false;
    const container = editorRef.current;

    void (async () => {
      const { default: QuillCtor } = await import("quill");
      if (cancelled || !container) return;

      quillRef.current = new QuillCtor(container, {
        theme: "snow",
        modules: { toolbar: TOOLBAR },
        placeholder: "Write your email…",
      });
      setEditorReady(true);
    })();

    return () => {
      cancelled = true;
      quillRef.current = null;
      if (container) container.innerHTML = "";
    };
  }, []);

  function bodyHtml(): string {
    return quillRef.current?.root.innerHTML ?? "";
  }

  // Persist the current content and return the campaign id, or null on failure
  // (feedback is set). Test and Send both save first so Resend always gets the
  // latest content.
  async function persist(): Promise<string | null> {
    const result = await saveCampaignDraftAction({
      campaignId,
      subject,
      previewText,
      bodyHtml: bodyHtml(),
    });

    if (!result.ok || !result.campaignId) {
      setFeedback({
        tone: "error",
        message: result.error ?? "Could not save.",
      });
      return null;
    }

    setCampaignId(result.campaignId);
    return result.campaignId;
  }

  async function handleSave() {
    setBusy("save");
    setFeedback(null);
    const id = await persist();
    if (id) setFeedback({ tone: "success", message: "Draft saved." });
    setBusy(null);
  }

  async function handleTest() {
    setBusy("test");
    setFeedback(null);
    const id = await persist();
    if (!id) {
      setBusy(null);
      return;
    }
    const result = await sendCampaignTestAction(id);
    setFeedback(
      result.ok
        ? { tone: "success", message: `Test email sent to ${result.sentTo}.` }
        : { tone: "error", message: result.error ?? "Test email failed." },
    );
    setBusy(null);
  }

  async function handleConfirmSend() {
    setBusy("send");
    setFeedback(null);

    const id = await persist();
    if (!id) {
      setBusy(null);
      setConfirmOpen(false);
      return;
    }

    let scheduledAt: string | undefined;
    if (scheduleEnabled) {
      if (!scheduledAtLocal) {
        setFeedback({ tone: "error", message: "Choose a schedule time." });
        setBusy(null);
        return;
      }
      scheduledAt = new Date(scheduledAtLocal).toISOString();
    }

    const result = await sendCampaignAction({ campaignId: id, scheduledAt });
    setConfirmOpen(false);
    setBusy(null);

    if (!result.ok) {
      setFeedback({ tone: "error", message: result.error ?? "Send failed." });
      return;
    }

    if (result.status === "scheduled") {
      setFeedback({
        tone: "success",
        message: `Campaign scheduled for ~${result.recipientCountEstimate} opted-in contacts.`,
      });
    } else {
      setFeedback({
        tone: "success",
        message: `Campaign sent to ~${result.recipientCountEstimate} opted-in contacts.`,
      });
    }

    // A sent/scheduled campaign is locked; start a fresh draft for the next one.
    setCampaignId(undefined);
    setSubject("");
    setPreviewText("");
    setScheduleEnabled(false);
    setScheduledAtLocal("");
    quillRef.current?.setText("");
  }

  const disabled = busy !== null;

  return (
    <div className="space-y-5 rounded-2xl border border-lh-line bg-white p-5">
      <div className="space-y-4">
        <label className="block text-sm font-semibold">
          <span className="mb-2 block">Subject</span>
          <input
            className={inputClass}
            disabled={disabled}
            maxLength={200}
            name="subject"
            onChange={(event) => setSubject(event.target.value)}
            placeholder="e.g. New spring lash sets are here"
            type="text"
            value={subject}
          />
        </label>

        <label className="block text-sm font-semibold">
          <span className="mb-2 block">
            Preview text{" "}
            <span className="font-normal text-lh-muted">
              (shown in the inbox next to the subject)
            </span>
          </span>
          <input
            className={inputClass}
            disabled={disabled}
            maxLength={200}
            name="previewText"
            onChange={(event) => setPreviewText(event.target.value)}
            placeholder="A short teaser line"
            type="text"
            value={previewText}
          />
        </label>

        <div className="text-sm font-semibold">
          <span className="mb-2 block">Email content</span>
          <div className="overflow-hidden rounded-xl border border-lh-line">
            <div ref={editorRef} style={{ minHeight: "16rem" }} />
          </div>
          {!editorReady ? (
            <p className="mt-2 text-xs font-normal text-lh-muted">
              Loading editor…
            </p>
          ) : null}
        </div>
      </div>

      <fieldset className="space-y-3 rounded-xl border border-lh-line p-4">
        <label className="flex items-center gap-2 text-sm font-semibold">
          <input
            checked={scheduleEnabled}
            disabled={disabled}
            onChange={(event) => setScheduleEnabled(event.target.checked)}
            type="checkbox"
          />
          Schedule for later
        </label>
        {scheduleEnabled ? (
          <label className="block text-sm font-semibold">
            <span className="mb-2 block">Send at</span>
            <input
              className={inputClass}
              disabled={disabled}
              onChange={(event) => setScheduledAtLocal(event.target.value)}
              type="datetime-local"
              value={scheduledAtLocal}
            />
          </label>
        ) : null}
      </fieldset>

      {feedback ? (
        <p
          className={`rounded-xl border p-3 text-sm ${
            feedback.tone === "error"
              ? "border-lh-accent/40 bg-lh-accent/5 text-lh-accent"
              : "border-lh-line bg-lh-neutral-2 text-lh-primary"
          }`}
          role="status"
        >
          {feedback.message}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button
          className={secondaryButtonClass}
          disabled={disabled}
          onClick={handleSave}
          type="button"
        >
          {busy === "save" ? "Saving…" : "Save draft"}
        </button>
        <button
          className={secondaryButtonClass}
          disabled={disabled}
          onClick={handleTest}
          type="button"
        >
          {busy === "test" ? "Sending test…" : "Send test to me"}
        </button>
        <button
          className={primaryButtonClass}
          disabled={disabled}
          onClick={() => {
            setFeedback(null);
            setConfirmOpen(true);
          }}
          type="button"
        >
          {scheduleEnabled ? "Schedule…" : "Send…"}
        </button>
      </div>

      {confirmOpen ? (
        <div className="space-y-3 rounded-2xl border border-lh-accent/30 bg-lh-neutral-2 p-4">
          <p className="text-sm">
            This will email approximately{" "}
            <strong>{optedInCount.toLocaleString("en-CA")}</strong> opted-in
            contact{optedInCount === 1 ? "" : "s"}
            {scheduleEnabled && scheduledAtLocal
              ? ` at ${new Date(scheduledAtLocal).toLocaleString("en-CA")}`
              : " now"}
            . This cannot be undone.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              className={primaryButtonClass}
              disabled={disabled}
              onClick={handleConfirmSend}
              type="button"
            >
              {busy === "send"
                ? "Working…"
                : scheduleEnabled
                  ? "Confirm schedule"
                  : "Confirm send"}
            </button>
            <button
              className={secondaryButtonClass}
              disabled={disabled}
              onClick={() => setConfirmOpen(false)}
              type="button"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const inputClass =
  "min-h-11 w-full rounded-xl border border-lh-line bg-white px-3 py-2 text-sm font-normal";
const primaryButtonClass =
  "inline-flex min-h-11 items-center justify-center rounded-full bg-lh-primary px-5 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50";
const secondaryButtonClass =
  "inline-flex min-h-11 items-center justify-center rounded-full border border-lh-line px-4 py-2 text-sm font-semibold hover:bg-lh-neutral-2 disabled:opacity-50";
