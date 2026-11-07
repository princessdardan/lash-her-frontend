import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hideP2LessonDocument, p2InteractiveBrowserEntryPath, p2LessonEntryPaths, p2LessonResumePaths, validateP2InteractiveBrowserInput,
  validateP2InteractiveBrowserPermit, validateP2LessonAckLossReceipt, validateP2LessonExitSaveReceipt, validateP2LessonRestoreReceipt,
  validateP2LessonResumeReceipt, validateP2LessonVisibilityReceipt, watchP2LessonAckLoss, watchP2LessonExitSave, watchP2LessonRestore,
  watchP2LessonResume, watchP2LessonVisibility } from "./p2-lifecycle-browser-recorder.mjs";

const origin = "https://staging.lashher.com", mediaHost = "stream.mux.com";
const cache = { "cache-control": "private, no-store" };
const refused = /P2_INTERACTIVE_LESSON_RESUME_RESPONSE_REFUSED/u;
const restoreRefused = /P2_INTERACTIVE_LESSON_RESTORE_RESPONSE_REFUSED/u;
const ackLossRefused = /P2_INTERACTIVE_LESSON_ACK_LOSS_RESPONSE_REFUSED/u;
const exitSaveRefused = /P2_INTERACTIVE_LESSON_EXIT_SAVE_RESPONSE_REFUSED/u;
const visibilityRefused = /P2_INTERACTIVE_LESSON_VISIBILITY_RESPONSE_REFUSED/u;

function selection(restoring = false) {
  const target = { actorId: randomUUID(), operation: "play-and-rewind", courseId: randomUUID(), lessonId: randomUUID(), grantId: randomUUID() };
  const input = { version: 2, environment: "staging", actionId: "owned-lesson-resume", challenge: "b".repeat(64), bindingSha256: "c".repeat(64),
    sourceCommit: "1".repeat(40), deploymentId: "dpl_ownedBrowser", deploymentUrl: "https://owned-browser.vercel.app",
    browserOrigin: origin, stage: "lesson-resume", epoch: "11", windowSeconds: 60 };
  const playbackId = "ownedResume" + randomUUID().replaceAll("-", ""), date = new Date(Math.floor(Date.now() / 1000) * 1000);
  const expires = new Date(date.getTime() + 600_000).toISOString();
  const b64 = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = aud => [b64({ alg: "RS256", kid: "owned-resume" }), b64({ aud, sub: playbackId, exp: date.getTime() / 1000 + 600 }),
    Buffer.from("owned fixture signature").toString("base64url")].join(".");
  const authorization = { playbackId, playbackToken: token("v"), thumbnailToken: token("t"), expiresAt: expires, thumbnailExpiresAt: expires };
  const playback = { requestId: randomUUID(), expiresAt: expires, thumbnailExpiresAt: expires, lifetimeMs: 600_000,
    playbackIdSha256: createHash("sha256").update(playbackId).digest("hex") };
  const started = { requestId: randomUUID(), progressId: randomUUID(), enrollmentId: randomUUID(), revision: 1 };
  const writes = [[10, 10, 10], [14, 13, 14], [4, 14, 14]].map(([resumePositionSeconds, submittedMaxPositionSeconds, maxPositionSeconds], index) => ({
    requestId: randomUUID(), expectedProgressRevision: index + 1, revision: index + 2, resumePositionSeconds, submittedMaxPositionSeconds, maxPositionSeconds,
  }));
  const paths = p2LessonResumePaths(target);
  const receipt = { page: { pathname: paths.lessonPath, status: 200 }, playback, started, writes,
    media: { durationSeconds: 32, videoWidth: 320, heartbeatSeconds: 10, pausedSeconds: 14, rewoundSeconds: 4,
      manifestObserved: true, segmentObserved: true } };
  if (restoring) {
    const { resumePositionSeconds, maxPositionSeconds } = writes.at(-1);
    const restoreTarget = { ...target, operation: "restore-resume", prior: { actionId: input.actionId, outcomeSha256: "d".repeat(64),
      progressId: started.progressId, enrollmentId: started.enrollmentId, resumePositionSeconds, maxPositionSeconds,
      playbackIdSha256: playback.playbackIdSha256, playbackExpiresAt: new Date(Date.parse(expires) - 1000).toISOString() } };
    return { input: { ...input, actionId: "owned-lesson-restore", stage: "lesson-restore", restore: restoreTarget }, target: restoreTarget,
      paths, authorization, date, receipt: { page: receipt.page, playback, started: { ...started, revision: 5 },
        restored: { ...started, requestId: randomUUID(), revision: 6, resumePositionSeconds, maxPositionSeconds },
        media: { durationSeconds: 32, videoWidth: 320, restoredSeconds: resumePositionSeconds, paused: true,
          manifestObserved: true, segmentObserved: true } } };
  }
  return { input: { ...input, resume: target }, target, paths, receipt, authorization, date };
}

function ackLossSelection() {
  const fixture = selection(true), { prior, ...existing } = fixture.target;
  const input = { ...fixture.input };
  delete input.restore;
  const { progressId, enrollmentId, resumePositionSeconds, maxPositionSeconds, playbackIdSha256 } = prior;
  const target = { ...existing, operation: "commit-drop-recover", progressId, enrollmentId, resumePositionSeconds, maxPositionSeconds, playbackIdSha256 };
  const row = (revision, resumePositionSeconds) => ({ requestId: randomUUID(), progressId, enrollmentId, revision, resumePositionSeconds, maxPositionSeconds });
  const playback = [fixture.receipt.playback, { ...fixture.receipt.playback, requestId: randomUUID() }];
  const writes = [row(7, resumePositionSeconds), row(8, resumePositionSeconds), row(9, maxPositionSeconds), row(10, maxPositionSeconds),
    row(11, maxPositionSeconds)];
  const recovery = { ...row(9, maxPositionSeconds), browserFailure: "connectionreset", unconfirmedObserved: true, noReplay: true };
  return { ...fixture, target, input: { ...input, actionId: "owned-lesson-ack-loss", stage: "lesson-ack-loss", ackLoss: target },
    receipt: { page: fixture.receipt.page, playback, writes, recovery, media: { beforeSeconds: resumePositionSeconds,
      afterSeconds: maxPositionSeconds, paused: true, manifestObserved: true, segmentObserved: true } } };
}

function exitSaveSelection(documentExit = false) {
  const fixture = ackLossSelection(), { ackLoss, ...input } = fixture.input;
  const target = { ...ackLoss, operation: documentExit ? "document-exit" : "spa-navigation" };
  const paths = p2LessonEntryPaths(target), playedSeconds = target.resumePositionSeconds + 3;
  return { ...fixture, paths, target, input: { ...input, actionId: "owned-lesson-exit-save", stage: "lesson-exit-save", exitSave: target },
    receipt: { page: fixture.receipt.page, playback: fixture.receipt.playback[0], writes: fixture.receipt.writes.slice(0, 2),
      exit: { pathname: paths.academyPath, status: 200, sameDocument: !documentExit, trustedPagehide: documentExit,
        trustedHidden: documentExit, resumePositionSeconds: playedSeconds, maxPositionSeconds: target.maxPositionSeconds, expectedProgressRevision: 8 },
      media: { playedSeconds, playing: true, manifestObserved: true, segmentObserved: true } } };
}

function visibilitySelection() {
  const fixture = exitSaveSelection(), { exitSave, ...input } = fixture.input;
  const target = { ...exitSave, operation: "hide-active-document" };
  const { page, playback, writes, media } = fixture.receipt;
  const { playedSeconds: resumePositionSeconds } = media;
  const { maxPositionSeconds } = target;
  return { ...fixture, target, input: { ...input, actionId: "owned-lesson-visibility-save", stage: "lesson-visibility-save", visibility: target },
    receipt: { page, playback, writes: [...writes, { ...writes[1], requestId: randomUUID(), revision: 9, resumePositionSeconds }],
      visibility: { sameDocument: true, trustedHidden: true, trustedPagehide: false, resumePositionSeconds,
        maxPositionSeconds, expectedProgressRevision: 8 }, media } };
}

test("resume permit and receipt bind the learner, media identity and monotonic CAS sequence", () => {
  const { input, target, paths, receipt } = selection(), issued = Math.floor(Date.now() / 1000), expires = issued + 60;
  const selector = (target.actorId + target.courseId + target.lessonId).replaceAll("-", "");
  const cookie = ["v2", input.epoch, input.stage, issued, expires, "a".repeat(32), selector, "b".repeat(64)].join(".");
  const permit = { stage: input.stage, epoch: input.epoch, expires, cookie };
  assert.equal(validateP2InteractiveBrowserInput(input), input);
  assert.equal(validateP2InteractiveBrowserPermit(permit, input), permit);
  assert.equal(p2InteractiveBrowserEntryPath(input, "learner"), paths.lessonPath);
  assert.throws(() => p2InteractiveBrowserEntryPath(input, "owner"));
  assert.throws(() => validateP2InteractiveBrowserInput({ ...input, resume: { ...target, operation: "restore" } }));
  for (const field of ["actorId", "courseId", "lessonId"]) {
    assert.throws(() => validateP2InteractiveBrowserPermit(permit, { ...input, resume: { ...target, [field]: randomUUID() } }));
  }
  assert.equal(validateP2LessonResumeReceipt(receipt, target), receipt);
  const [heartbeat, pause, rewind] = receipt.writes;
  for (const invalid of [
    { ...receipt, playback: { ...receipt.playback, playbackIdSha256: "0".repeat(64) } },
    { ...receipt, playback: { ...receipt.playback, playbackToken: "never retained" } },
    { ...receipt, writes: [heartbeat, pause, { ...rewind, requestId: pause.requestId }] },
    { ...receipt, writes: [heartbeat, { ...pause, resumePositionSeconds: 12, maxPositionSeconds: 13 }, rewind] },
    { ...receipt, writes: [heartbeat, pause, { ...rewind, expectedProgressRevision: 2 }] },
    { ...receipt, writes: [heartbeat, pause, { ...rewind, resumePositionSeconds: 5 }], media: { ...receipt.media, rewoundSeconds: 5 } },
    { ...receipt, writes: [heartbeat, pause, { ...rewind, maxPositionSeconds: 4 }] },
    { ...receipt, media: { ...receipt.media, durationSeconds: 21 } },
    { ...receipt, media: { ...receipt.media, segmentObserved: false } },
    { ...receipt, media: { ...receipt.media, heartbeatSeconds: 12 } },
  ]) assert.throws(() => validateP2LessonResumeReceipt(invalid, target));
});

test("restore permit and receipt require the accepted prior row, media and exact position", () => {
  const { input, target, paths, receipt } = selection(true), issued = Math.floor(Date.now() / 1000), expires = issued + 60;
  const selector = (target.actorId + target.courseId + target.lessonId).replaceAll("-", "");
  const cookie = ["v2", input.epoch, input.stage, issued, expires, "a".repeat(32), selector, "b".repeat(64)].join(".");
  const permit = { stage: input.stage, epoch: input.epoch, expires, cookie };
  assert.equal(validateP2InteractiveBrowserInput(input), input);
  assert.equal(validateP2InteractiveBrowserPermit(permit, input), permit);
  assert.equal(p2InteractiveBrowserEntryPath(input, "learner"), paths.lessonPath);
  assert.throws(() => p2InteractiveBrowserEntryPath(input, "owner"));
  for (const field of ["actorId", "courseId", "lessonId"]) {
    assert.throws(() => validateP2InteractiveBrowserPermit(permit, { ...input, restore: { ...target, [field]: randomUUID() } }));
  }
  for (const invalid of [
    { actionId: input.actionId }, { maxPositionSeconds: 13 }, { playbackExpiresAt: "2026-11-07" }, { outcomeSha256: "0".repeat(64) },
  ]) assert.throws(() => validateP2InteractiveBrowserInput({ ...input, restore: { ...target, prior: { ...target.prior, ...invalid } } }));
  assert.equal(validateP2LessonRestoreReceipt(receipt, target), receipt);
  for (const invalid of [
    { ...receipt, playback: { ...receipt.playback, playbackIdSha256: "e".repeat(64) } },
    { ...receipt, started: { ...receipt.started, requestId: receipt.playback.requestId } },
    { ...receipt, started: { ...receipt.started, progressId: randomUUID() } },
    { ...receipt, restored: { ...receipt.restored, enrollmentId: randomUUID() } },
    { ...receipt, restored: { ...receipt.restored, revision: 5 } },
    { ...receipt, restored: { ...receipt.restored, maxPositionSeconds: 4 } },
    { ...receipt, media: { ...receipt.media, restoredSeconds: 5 } },
    { ...receipt, media: { ...receipt.media, paused: false } },
    { ...receipt, media: { ...receipt.media, segmentObserved: false } },
  ]) assert.throws(() => validateP2LessonRestoreReceipt(invalid, target));
});

test("lost acknowledgement requires a fixed permit, committed row, authoritative read and reload", () => {
  const { input, target, paths, receipt } = ackLossSelection(), issued = Math.floor(Date.now() / 1000), expires = issued + 60;
  const selector = (target.actorId + target.courseId + target.lessonId).replaceAll("-", "");
  const cookie = ["v2", input.epoch, input.stage, issued, expires, "a".repeat(32), selector, "b".repeat(64)].join(".");
  const permit = { stage: input.stage, epoch: input.epoch, expires, cookie };
  assert.equal(validateP2InteractiveBrowserInput(input), input);
  assert.equal(validateP2InteractiveBrowserPermit(permit, input), permit);
  assert.equal(p2InteractiveBrowserEntryPath(input, "learner"), paths.lessonPath);
  assert.throws(() => p2InteractiveBrowserEntryPath(input, "owner"));
  for (const field of ["actorId", "courseId", "lessonId"]) {
    assert.throws(() => validateP2InteractiveBrowserPermit(permit, { ...input, ackLoss: { ...target, [field]: randomUUID() } }));
  }
  for (const invalid of [{ operation: "restore-resume" }, { resumePositionSeconds: 2 }, { maxPositionSeconds: 13 }, { playbackIdSha256: "0".repeat(64) }]) {
    assert.throws(() => validateP2InteractiveBrowserInput({ ...input, ackLoss: { ...target, ...invalid } }));
  }
  assert.equal(validateP2LessonAckLossReceipt(receipt, target), receipt);
  const [start, restore, committed, reload, resumed] = receipt.writes;
  for (const invalid of [
    { ...receipt, writes: [start, restore, { ...committed, revision: 8 }, reload, resumed] },
    { ...receipt, writes: [start, restore, committed, reload, { ...resumed, maxPositionSeconds: 4 }] },
    { ...receipt, playback: [receipt.playback[0], { ...receipt.playback[1], playbackIdSha256: "e".repeat(64) }] },
    { ...receipt, recovery: { ...receipt.recovery, progressId: randomUUID() } },
    { ...receipt, recovery: { ...receipt.recovery, requestId: committed.requestId } },
    { ...receipt, recovery: { ...receipt.recovery, noReplay: false } },
    { ...receipt, recovery: { ...receipt.recovery, unconfirmedObserved: false } },
    { ...receipt, media: { ...receipt.media, afterSeconds: 4 } },
  ]) assert.throws(() => validateP2LessonAckLossReceipt(invalid, target));
});

test("exit-save permit and receipt bind the selected row and genuine navigation mode", () => {
  for (const documentExit of [false, true]) {
    const { input, target, paths, receipt } = exitSaveSelection(documentExit), issued = Math.floor(Date.now() / 1000), expires = issued + 60;
    const selector = (target.actorId + target.courseId + target.lessonId).replaceAll("-", "");
    const cookie = ["v2", input.epoch, input.stage, issued, expires, "a".repeat(32), selector, "b".repeat(64)].join(".");
    const permit = { stage: input.stage, epoch: input.epoch, expires, cookie };
    assert.equal(validateP2InteractiveBrowserInput(input), input);
    assert.equal(validateP2InteractiveBrowserPermit(permit, input), permit);
    assert.equal(p2InteractiveBrowserEntryPath(input, "learner"), paths.lessonPath);
    assert.equal(validateP2LessonExitSaveReceipt(receipt, target), receipt);
    for (const change of [
      { sameDocument: documentExit }, { trustedPagehide: !documentExit }, { trustedHidden: !documentExit },
      { pathname: paths.lessonPath }, { expectedProgressRevision: 9 }, { maxPositionSeconds: target.maxPositionSeconds + 1 },
      { resumePositionSeconds: target.resumePositionSeconds + 1 },
    ]) assert.throws(() => validateP2LessonExitSaveReceipt({ ...receipt, exit: { ...receipt.exit, ...change } }, target));
    assert.throws(() => validateP2LessonExitSaveReceipt({ ...receipt, writes: [receipt.writes[0],
      { ...receipt.writes[1], progressId: randomUUID() }] }, target));
    assert.throws(() => validateP2LessonExitSaveReceipt({ ...receipt, media: { ...receipt.media, playing: false } }, target));
  }
});

test("visibility permit and receipt require the original hidden document and saved revision", () => {
  const { input, target, paths, receipt } = visibilitySelection(), issued = Math.floor(Date.now() / 1000), expires = issued + 60;
  input.epoch = "123456789012345678";
  const selector = (target.actorId + target.courseId + target.lessonId).replaceAll("-", "");
  const cookie = ["v2", input.epoch, input.stage, issued, expires, "a".repeat(32), selector, "b".repeat(64)].join(".");
  const permit = { stage: input.stage, epoch: input.epoch, expires, cookie };
  assert.equal(cookie.length, 261);
  assert.equal(validateP2InteractiveBrowserInput(input), input);
  assert.equal(validateP2InteractiveBrowserPermit(permit, input), permit);
  assert.equal(p2InteractiveBrowserEntryPath(input, "learner"), paths.lessonPath);
  assert.equal(validateP2LessonVisibilityReceipt(receipt, target), receipt);
  assert.throws(() => validateP2InteractiveBrowserPermit(permit, { ...input, visibility: { ...target, actorId: randomUUID() } }));
  for (const change of [
    { sameDocument: false }, { trustedPagehide: true }, { trustedHidden: false },
    { expectedProgressRevision: 9 }, { maxPositionSeconds: target.maxPositionSeconds + 1 },
    { resumePositionSeconds: target.resumePositionSeconds + 1 },
  ]) assert.throws(() => validateP2LessonVisibilityReceipt({ ...receipt, visibility: { ...receipt.visibility, ...change } }, target));
  for (const change of [
    { revision: 8 }, { progressId: randomUUID() }, { enrollmentId: randomUUID() },
    { requestId: receipt.playback.requestId }, { resumePositionSeconds: receipt.visibility.resumePositionSeconds + 1 },
  ]) assert.throws(() => validateP2LessonVisibilityReceipt({ ...receipt, writes: [...receipt.writes.slice(0, 2),
    { ...receipt.writes[2], ...change }] }, target));
});

function ownedLesson(paths, scenario, prior) {
  const exitSave = scenario.startsWith("exit-");
  const visibility = scenario.startsWith("visibility-");
  return `<!doctype html><main><h1>Owned lesson</h1><p id="progress">Saving progress…</p>
  ${exitSave ? `<a id="course" href="${paths.academyPath}">Owned course</a>` : ""}</main>
  <script src="/owned-mux-player.js"></script><script>
    const { paths, scenario, prior, exitSave, visibility } = ${JSON.stringify({ paths, scenario, exitSave, visibility, prior: prior && {
      resumePositionSeconds: prior.resumePositionSeconds, maxPositionSeconds: prior.maxPositionSeconds,
    } })};
    const post = (body,keepalive=false) => fetch(paths.progressPath, {method:'POST',headers:{'content-type':'application/json','x-lash-csrf':'1'},body:JSON.stringify(body),keepalive});
    const status = document.querySelector('#progress');
    let revision = exitSave || visibility ? 6 : prior ? 4 : 0, lastSent = 0, watched = 0, acknowledgedMax = 0, seeking = false;
    const initial = {event:'lesson_started',expectedProgressRevision:revision};
    const start = post(initial).then(response => response.json()).then(({progress}) => {
      revision = progress.revision;
      status.textContent = 'Progress saved to your account.';
    });
    if (scenario === 'duplicate') void post(initial);
    void fetch(paths.playbackPath).then(response => response.json()).then(authorization => {
      const player = document.createElement('mux-player');
      player.style.cssText = 'display:block;width:640px;height:360px';
      player.playbackId = authorization.playbackId;
      player.tokens = {playback:authorization.playbackToken,thumbnail:authorization.thumbnailToken};
      player.preload = 'metadata';
      player.streamType = 'on-demand';
      player.disableTracking = true;
      player.disableCookies = true;
      player.storyboardSrc = '';
      if (prior) {
        player.addEventListener('loadedmetadata', () => {
          player.currentTime = prior.resumePositionSeconds + (scenario === 'restore-native-drift' ? 1 : 0);
        }, {once:true});
        player.addEventListener('seeked', async () => {
          await start;
          const resumePositionSeconds = scenario === 'restore-native-drift' ? prior.resumePositionSeconds : Math.floor(player.currentTime);
          const update = {resumePositionSeconds,maxPositionSeconds:prior.maxPositionSeconds,expectedProgressRevision:revision};
          const {progress} = await post(update).then(response => response.json());
          revision = progress.revision;
          if (scenario === 'restore-extra') setTimeout(() => void post({...update,expectedProgressRevision:6}), 1000);
        }, {once:true});
        if (exitSave || visibility) {
          const save = () => {
            const resumePositionSeconds = Math.floor(player.currentTime);
            void post({resumePositionSeconds,maxPositionSeconds:prior.maxPositionSeconds+(scenario==='exit-document-wrong-max'?1:0),
              expectedProgressRevision:revision},true).then(async response => {
              if (visibility && response.ok) {
                const {progress} = await response.json();
                revision = progress.revision;
              }
            });
          };
          if (visibility) {
            document.addEventListener('visibilitychange', event => {
              if (!event.isTrusted || document.visibilityState !== 'hidden') return;
              save();
              if (scenario === 'visibility-replay') save();
            });
          } else if (scenario === 'exit-document-early-save') {
            const earlySave = () => {
              if (player.paused || player.currentTime < prior.resumePositionSeconds + 4) return;
              player.removeEventListener('timeupdate',earlySave);
              save();
            };
            player.addEventListener('timeupdate',earlySave);
          } else if (scenario.startsWith('exit-document')) addEventListener('pagehide',save);
          else document.querySelector('#course').addEventListener('click', async event => {
            event.preventDefault();
            const response = await fetch(paths.academyPath+'?_rsc=owned',{headers:{RSC:'1'}});
            if (!response.ok) return;
            history.pushState({},'',paths.academyPath);
            save();
            if (scenario === 'exit-spa-replay') save();
            document.querySelector('main').replaceChildren(Object.assign(document.createElement('h1'),{textContent:'Owned course'}));
          });
        }
        document.querySelector('main').append(player);
        return;
      }
      const save = () => {
        lastSent = Math.floor(player.currentTime);
        const resumePositionSeconds = lastSent, maxPositionSeconds = Math.max(acknowledgedMax, watched);
        void post({resumePositionSeconds,maxPositionSeconds,expectedProgressRevision:revision})
          .then(response => response.json()).then(({progress}) => {
            revision = progress.revision;
            acknowledgedMax = progress.maxPositionSeconds;
            status.textContent = 'Progress saved to your account.';
          });
      };
      player.addEventListener('timeupdate', () => {
        if (seeking || !player.readyState) return;
        const current = Math.floor(player.currentTime);
        if (!player.paused) watched = Math.max(watched,current);
        if (Math.abs(current-lastSent) >= 10) save();
      });
      player.addEventListener('pause', save);
      player.addEventListener('seeking', () => { seeking = true; });
      player.addEventListener('seeked', () => { seeking = false; save(); });
      document.querySelector('main').append(player);
    });
  </script>`;
}

function ownedAckLossLesson(paths, target, revision, replay) {
  const lesson = { playbackPath: paths.playbackPath, progressPath: paths.progressPath, latestPath: "/api/academy/progress?lessonId=" + target.lessonId,
    initialPosition: revision === 6 ? target.resumePositionSeconds : target.maxPositionSeconds, revision, maximum: target.maxPositionSeconds, replay };
  return `<!doctype html><main><h1>Owned lesson</h1><p id="progress">Saving progress…</p><div role="alert" hidden></div></main>
  <script src="/owned-mux-player.js"></script><script>
    const lesson = ${JSON.stringify(lesson)};
    const post = body => fetch(lesson.progressPath, {method:'POST',headers:{'content-type':'application/json','x-lash-csrf':'1'},body:JSON.stringify(body)});
    const status = document.querySelector('#progress'), alert = document.querySelector('[role=alert]');
    let revision = lesson.revision;
    const start = post({event:'lesson_started',expectedProgressRevision:revision}).then(response => response.json()).then(({progress}) => {
      revision = progress.revision;
      status.textContent = 'Progress saved to your account.';
    });
    void fetch(lesson.playbackPath).then(response => response.json()).then(authorization => {
      const player = document.createElement('mux-player');
      player.style.cssText = 'display:block;width:640px;height:360px';
      player.playbackId = authorization.playbackId;
      player.tokens = {playback:authorization.playbackToken,thumbnail:authorization.thumbnailToken};
      player.preload = 'metadata';
      player.streamType = 'on-demand';
      player.disableTracking = true;
      player.disableCookies = true;
      player.storyboardSrc = '';
      player.addEventListener('loadedmetadata', () => { player.currentTime = lesson.initialPosition; }, {once:true});
      player.addEventListener('seeked', async () => {
        await start;
        const body = {resumePositionSeconds:Math.floor(player.currentTime),maxPositionSeconds:lesson.maximum,expectedProgressRevision:revision};
        try {
          const response = await post(body), {progress} = await response.json();
          revision = progress.revision;
        } catch {
          alert.textContent = 'Progress has not been confirmed.';
          alert.hidden = false;
          const retry = document.createElement('button');
          retry.textContent = 'Retry saving progress';
          alert.append(retry);
          retry.onclick = async () => {
            if (lesson.replay) await post(body);
            const {progress} = await fetch(lesson.latestPath).then(response => response.json());
            if (progress.length !== 1) return;
            const reload = document.createElement('button');
            reload.textContent = 'Load latest progress';
            reload.onclick = () => location.reload();
            alert.replaceChildren(reload);
          };
        }
      });
      document.querySelector('main').append(player);
    });
  </script>`;
}

test("owned Chromium plays, restores and saves Mux progress through native visibility, exit and acknowledgement loss", {
  skip: process.env.P2_INTERACTIVE_BROWSER_OWNED_TEST !== "true",
}, async () => {
  const { chromium } = await import("playwright"), root = mkdtempSync(join(tmpdir(), "owned-p2-resume-"));
  const host = new URL(origin).hostname, allowed = new Set([host, mediaHost, "image.mux.com"]);
  const key = join(root, "key.pem"), cert = join(root, "cert.pem"), sockets = new Set();
  const bundle = readFileSync(new URL("mux-player.js", import.meta.resolve("@mux/mux-player")));
  const playlist = readFileSync(new URL("../../tests/fixtures/course-mux-long.m3u8", import.meta.url));
  const segment = readFileSync(new URL("../../tests/fixtures/course-mux-0.mpegts", import.meta.url));
  let browser, visibilityBrowser, https, proxy, serve;
  const track = socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); };
  const bind = server => new Promise((done, fail) => {
    server.on("connection", track);
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => done(server.address().port));
  });
  try {
    assert.equal(spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", `/CN=${host}`, "-keyout", key, "-out", cert], { stdio: "ignore" }).status, 0);
    https = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (request, response) => {
      if (!serve || !allowed.has(request.headers.host)) return response.writeHead(403).end();
      void serve(request, response).catch(() => response.destroy());
    });
    const tlsPort = await bind(https);
    proxy = createHttpServer((_request, response) => response.writeHead(403).end());
    proxy.on("connect", (request, socket, head) => {
      if (![...allowed].some(name => request.url === name + ":443")) { socket.destroy(); return; }
      const target = connect(tlsPort, "127.0.0.1");
      track(target);
      target.once("error", () => socket.destroy());
      socket.once("error", () => target.destroy());
      target.once("connect", () => {
        socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
        if (head.length) target.write(head);
        socket.pipe(target).pipe(socket);
      });
    });
    const proxyPort = await bind(proxy);
    browser = await chromium.launch();
    for (const scenario of ["normal", "duplicate", "restore", "restore-row-drift", "restore-native-drift", "restore-extra",
      "ack-loss", "ack-loss-forward-drift", "ack-loss-read-drift", "ack-loss-replay",
      "exit-spa", "exit-document", "exit-spa-replay", "exit-document-wrong-max", "exit-document-early-save",
      "visibility-native", "visibility-replay", "visibility-pagehide", "visibility-thawed"]) {
      const restoring = scenario.startsWith("restore");
      const ackLoss = scenario.startsWith("ack-loss");
      const exitSave = scenario.startsWith("exit-");
      const visibility = scenario.startsWith("visibility-"), lifecycleSave = exitSave || visibility;
      const { input, target, paths, receipt, authorization, date } = visibility ? visibilitySelection() : exitSave ? exitSaveSelection(scenario.startsWith("exit-document"))
        : ackLoss ? ackLossSelection() : selection(restoring), bodies = [];
      if (visibility && !visibilityBrowser) visibilityBrowser = await chromium.launch({ channel: "chromium" });
      const context = await (visibility ? visibilityBrowser : browser).newContext({
        proxy: { server: `http://127.0.0.1:${proxyPort}` }, ignoreHTTPSErrors: true,
      });
      if (ackLoss) await context.addCookies([{ name: "__Host-owned-ack-loss", value: "verified", url: origin, secure: true, httpOnly: true }]);
      let revision = ackLoss || lifecycleSave ? 6 : restoring ? 4 : 0, maxPositionSeconds = target.prior?.maxPositionSeconds ?? 0;
      let playbackCount = 0, documentCount = 0, authoritativeReads = 0, exitResponse = false;
      const ackRow = (position, revision) => ({ id: target.progressId, userId: target.actorId, lessonId: target.lessonId,
        enrollmentId: target.enrollmentId, resumePositionSeconds: position, maxPositionSeconds: target.maxPositionSeconds, revision,
        completedQuizRevision: null, completedAt: null, lastWatchedAt: date.toISOString(), createdAt: date.toISOString(), updatedAt: date.toISOString() });
      serve = async (request, response) => {
        const send = (status, type, value, headers = {}) => {
          const body = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
          response.writeHead(status, { "content-type": type, "content-length": body.length, ...headers }).end(body);
        };
        if (request.headers.host === mediaHost) {
          const url = new URL(request.url, "https://" + mediaHost), cors = { "access-control-allow-origin": origin };
          if (url.pathname === "/" + authorization.playbackId + ".m3u8" && url.searchParams.get("token") === authorization.playbackToken) {
            return send(200, "application/vnd.apple.mpegurl", playlist, cors);
          }
          if (url.pathname === "/course-mux-0.mpegts" && /^[0-3]$/u.test(url.searchParams.get("segment") ?? "")) {
            return send(200, "video/mp2t", segment, cors);
          }
          return send(404, "text/plain", "", cors);
        }
        if (request.headers.host !== host) return send(404, "text/plain", "");
        if (request.url === paths.lessonPath) {
          documentCount++;
          return send(200, "text/html", ackLoss ? ownedAckLossLesson(paths, target, revision, scenario === "ack-loss-replay")
            : ownedLesson(paths, scenario, lifecycleSave ? target : target.prior), cache);
        }
        if (exitSave && request.url === paths.academyPath + "?_rsc=owned" && request.headers.rsc === "1")
          return send(200, "text/x-component", "Owned outline", cache);
        if (exitSave && request.url === paths.academyPath) {
          if (scenario === "exit-document-early-save") await new Promise(resolve => setTimeout(resolve, 2_000));
          return send(200, "text/html", "<!doctype html><main><h1>Owned course</h1></main>", cache);
        }
        if (request.url === "/owned-mux-player.js") return send(200, "application/javascript", bundle);
        if (request.url === paths.playbackPath) return send(200, "application/json", authorization,
          { ...cache, date: date.toUTCString(), "x-request-id": ackLoss ? receipt.playback[playbackCount++].requestId : receipt.playback.requestId });
        if (ackLoss && request.url === "/api/academy/progress?lessonId=" + target.lessonId) {
          authoritativeReads++;
          return send(200, "application/json", { progress: [ackRow(target.maxPositionSeconds, scenario === "ack-loss-read-drift" ? 8 : revision)] },
            { ...cache, "x-request-id": receipt.recovery.requestId });
        }
        if (request.url === paths.progressPath) {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const body = JSON.parse(Buffer.concat(chunks).toString());
          bodies.push(body);
          if (ackLoss) {
            if (request.headers.origin !== origin || request.headers.cookie !== "__Host-owned-ack-loss=verified"
              || request.headers["x-lash-csrf"] !== "1") return send(403, "application/json", {}, cache);
            if (body.expectedProgressRevision !== revision || revision >= 11) return send(409, "application/json", {}, cache);
            const observed = receipt.writes[revision++ - 6];
            const drift = scenario === "ack-loss-forward-drift" && revision === 9;
            return send(200, "application/json", { progress: ackRow(observed.resumePositionSeconds, drift ? 8 : revision) },
              { ...cache, "x-request-id": observed.requestId });
          }
          if (lifecycleSave) {
            if (request.headers.origin !== origin || request.headers["x-lash-csrf"] !== "1"
              || body.expectedProgressRevision !== revision || revision >= 9 || (revision === 8 && body.maxPositionSeconds !== target.maxPositionSeconds))
              return send(409, "application/json", {}, cache);
            const requestId = receipt.writes[revision - 6]?.requestId ?? randomUUID();
            const row = ackRow(body.resumePositionSeconds ?? target.resumePositionSeconds, ++revision);
            if (revision === 9) {
              await new Promise(resolve => setTimeout(resolve, 300));
              exitResponse = true;
            }
            return send(200, "application/json", { progress: row }, { ...cache, "x-request-id": requestId });
          }
          if (body.expectedProgressRevision !== revision || revision >= (restoring ? 6 : 4)) return send(409, "application/json", {}, cache);
          const { resumePositionSeconds = target.prior?.resumePositionSeconds ?? 0, maxPositionSeconds: submitted = 0 } = body;
          maxPositionSeconds = Math.max(maxPositionSeconds, submitted, resumePositionSeconds);
          const requestId = restoring ? (revision === 4 ? receipt.started.requestId : receipt.restored.requestId)
            : (revision === 0 ? receipt.started.requestId : receipt.writes[revision - 1].requestId);
          const drift = scenario === "restore-row-drift" && revision === 5 ? 1 : 0;
          return send(200, "application/json", { progress: { id: receipt.started.progressId, userId: target.actorId, lessonId: target.lessonId,
            enrollmentId: receipt.started.enrollmentId, resumePositionSeconds: resumePositionSeconds + drift, maxPositionSeconds, revision: ++revision,
            completedQuizRevision: null, completedAt: null, lastWatchedAt: date.toISOString(), createdAt: date.toISOString(), updatedAt: date.toISOString(),
          } }, { ...cache, "x-request-id": requestId });
        }
        return send(404, "text/plain", "");
      };
      const page = await context.newPage();
      const recorder = visibility ? watchP2LessonVisibility(context, page, input,
        scenario === "visibility-pagehide" ? () => page.goto("about:blank") : hideP2LessonDocument)
        : (exitSave ? watchP2LessonExitSave : ackLoss ? watchP2LessonAckLoss : restoring ? watchP2LessonRestore
          : watchP2LessonResume)(context, page, input);
      const expires = Math.floor(Date.now() / 1000) + 35;
      try {
        if (scenario === "duplicate") await assert.rejects(recorder.open(expires), refused);
        else if (scenario === "restore-row-drift") await assert.rejects(recorder.open(expires), restoreRefused);
        else if (visibility) {
          await recorder.open(expires);
          if (scenario === "visibility-native" || scenario === "visibility-thawed") {
            await recorder.wait(expires).catch(error => {
              throw new Error(`Owned ${scenario} failed after ${bodies.length} progress requests`, { cause: error });
            });
            const observed = recorder.finish();
            assert.equal(validateP2LessonVisibilityReceipt(observed, target), observed);
            assert.deepEqual(observed.writes.slice(0, 2), receipt.writes.slice(0, 2));
            assert.deepEqual(observed.playback, receipt.playback);
            assert.ok(exitResponse);
            assert.equal(revision, 9);
            assert.equal(documentCount, 1);
            assert.deepEqual(bodies.map(body => body.expectedProgressRevision), [6, 7, 8]);
            assert.equal(observed.writes.at(-1).requestId, receipt.writes.at(-1).requestId);
            assert.equal(observed.visibility.resumePositionSeconds, bodies.at(-1).resumePositionSeconds);
            if (scenario === "visibility-native") {
              const cover = context.pages().find(candidate => candidate !== page);
              assert.equal(cover?.url(), "about:blank");
              await new Promise(resolve => setTimeout(resolve, 250));
              await recorder.confirmFenced();
              assert.equal(documentCount, 1);
              assert.equal(bodies.length, 3);
              await assert.rejects(recorder.confirmFenced(), visibilityRefused);
            } else {
              const protocol = await context.newCDPSession(page);
              try {
                await protocol.send("Page.setWebLifecycleState", { state: "active" });
                await assert.rejects(recorder.confirmFenced(), visibilityRefused);
              } finally { await protocol.detach(); }
            }
          } else {
            await assert.rejects(recorder.wait(expires), visibilityRefused);
            assert.throws(() => recorder.finish(), visibilityRefused);
          }
        }
        else if (exitSave) {
          await recorder.open(expires);
          if (scenario === "exit-spa" || scenario === "exit-document") {
            await recorder.wait(expires).catch(error => {
              throw new Error(`Owned ${scenario} failed after ${bodies.length} progress requests`, { cause: error });
            });
            const observed = recorder.finish();
            assert.equal(validateP2LessonExitSaveReceipt(observed, target), observed);
            assert.deepEqual(observed.writes, receipt.writes);
            assert.deepEqual(observed.playback, receipt.playback);
            const exitDeadline = Date.now() + 2_000;
            while (!exitResponse && Date.now() < exitDeadline) await new Promise(resolve => setTimeout(resolve, 20));
            assert.ok(exitResponse);
            assert.equal(revision, 9);
            assert.deepEqual(bodies.map(body => body.expectedProgressRevision), [6, 7, 8]);
            assert.equal(observed.exit.resumePositionSeconds, bodies.at(-1).resumePositionSeconds);
            assert.equal(observed.exit.maxPositionSeconds, bodies.at(-1).maxPositionSeconds);
          } else {
            if (scenario === "exit-document-early-save") {
              const detached = page.waitForEvent("requestfailed", { timeout: 8_000, predicate: request =>
                request.url() === origin + paths.progressPath && request.method() === "POST"
                && request.postDataJSON()?.expectedProgressRevision === 8 && request.failure()?.errorText === "net::ERR_ABORTED" });
              await Promise.all([detached, assert.rejects(recorder.wait(expires), exitSaveRefused)]);
              assert.ok(exitResponse);
              assert.equal(revision, 9);
            } else await assert.rejects(recorder.wait(expires), exitSaveRefused);
            assert.throws(() => recorder.finish(), exitSaveRefused);
          }
        } else if (ackLoss) {
          await recorder.open(expires);
          if (scenario === "ack-loss") {
            await recorder.wait(expires).catch(error => {
              throw new Error(`Owned lost acknowledgement failed after ${bodies.length} progress requests and ${authoritativeReads} reads`, { cause: error });
            });
            assert.deepEqual(recorder.finish(), receipt);
            assert.deepEqual(bodies.map(body => body.expectedProgressRevision), [6, 7, 8, 9, 10]);
            assert.equal(authoritativeReads, 1);
            assert.equal(documentCount, 2);
            assert.equal(revision, 11);
          } else {
            await assert.rejects(recorder.wait(expires), ackLossRefused);
            assert.throws(() => recorder.finish(), ackLossRefused);
            assert.equal(documentCount, 1);
            assert.equal(revision, 9);
            assert.equal(authoritativeReads, scenario === "ack-loss-read-drift" ? 1 : 0);
          }
        } else if (restoring) {
          await recorder.open(expires);
          if (scenario === "restore-native-drift") {
            await assert.rejects(recorder.wait(Math.floor(Date.now() / 1000) + 4), restoreRefused);
          } else if (scenario === "restore-extra") {
            const extra = page.waitForRequest(request => request.method() === "POST" && request.postDataJSON()?.expectedProgressRevision === 6);
            await Promise.all([extra, recorder.wait(expires).catch(error => assert.match(error.message, restoreRefused))]);
            assert.throws(() => recorder.finish(), restoreRefused);
          } else {
            await recorder.wait(expires);
            const observed = recorder.finish();
            assert.equal(validateP2LessonRestoreReceipt(observed, target), observed);
            assert.deepEqual(observed.playback, receipt.playback);
            assert.deepEqual(observed.started, receipt.started);
            assert.deepEqual(observed.restored, receipt.restored);
            assert.deepEqual(bodies, [{ event: "lesson_started", expectedProgressRevision: 4 }, {
              resumePositionSeconds: target.prior.resumePositionSeconds, maxPositionSeconds: target.prior.maxPositionSeconds, expectedProgressRevision: 5,
            }]);
            assert.ok(observed.media.videoWidth > 0);
          }
        }
        else {
          await recorder.open(expires);
          await recorder.wait(expires).catch(error => {
            throw new Error(`Owned resume failed after ${bodies.length} progress requests`, { cause: error });
          });
          const observed = recorder.finish();
          assert.equal(validateP2LessonResumeReceipt(observed, target), observed);
          assert.deepEqual(observed.playback, receipt.playback);
          assert.deepEqual(observed.started, receipt.started);
          assert.deepEqual(bodies.map(body => body.expectedProgressRevision), [0, 1, 2, 3]);
          assert.equal(observed.writes[2].resumePositionSeconds, observed.writes[1].resumePositionSeconds - 10);
          assert.equal(observed.writes[2].maxPositionSeconds, observed.writes[1].maxPositionSeconds);
          assert.ok(observed.media.videoWidth > 0);
          assert.equal(observed.media.manifestObserved, true);
          assert.equal(observed.media.segmentObserved, true);
        }
      } finally {
        await recorder.close();
        await context.close();
      }
    }
  } finally {
    await Promise.all([browser?.close(), visibilityBrowser?.close()]);
    for (const socket of sockets) socket.destroy();
    await Promise.all([proxy, https].filter(Boolean).map(server => new Promise(done => server.close(done))));
    rmSync(root, { recursive: true, force: true });
  }
});
