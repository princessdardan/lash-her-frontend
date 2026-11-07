import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { p2InteractiveBrowserEntryPath, p2LessonAssessmentPaths, validateP2InteractiveBrowserInput,
  validateP2InteractiveBrowserPermit, validateP2LessonAssessmentReceipt, watchP2LessonAssessment } from "./p2-lifecycle-browser-recorder.mjs";

const origin = "https://staging.lashher.com";
const refusal = /P2_INTERACTIVE_LESSON_ASSESSMENT_RESPONSE_REFUSED/u;
const privateCache = { "cache-control": "private, no-store" };

function selection() {
  const answers = optionId => [{ questionId: "zeta", optionId }, { questionId: "alpha", optionId }];
  const target = { actorId: randomUUID(), operation: "fail-then-pass", courseId: randomUUID(), lessonId: randomUUID(), grantId: randomUUID(),
    quizRevision: 7, failAnswers: answers("poor"), passAnswers: answers("good") };
  const input = { version: 2, environment: "staging", actionId: "owned-lesson-assessment", challenge: "b".repeat(64), bindingSha256: "c".repeat(64),
    sourceCommit: "1".repeat(40), deploymentId: "dpl_ownedBrowser", deploymentUrl: "https://owned-browser.vercel.app",
    browserOrigin: origin, stage: "lesson-assessment", epoch: "11", windowSeconds: 60, assessment: target };
  const paths = p2LessonAssessmentPaths(target), quizRevisionId = randomUUID(), enrollmentId = randomUUID(), progressId = randomUUID();
  const receipt = { page: { pathname: paths.lessonPath, status: 200 }, playback: { requestId: randomUUID(), status: 404 },
    started: { requestId: randomUUID(), progressId, enrollmentId, revision: 1 }, attempts: [false, true].map((passed, index) => {
      const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index + 1)).toISOString();
      return { requestId: randomUUID(), payloadRequestId: randomUUID(), attemptId: randomUUID(), quizRevisionId,
        quizRevision: target.quizRevision, correctCount: passed ? 2 : 0, totalCount: 2, passed, completed: passed, createdAt,
        progress: { requestId: randomUUID(), progressId, enrollmentId, revision: index + 2,
          completedAt: passed ? createdAt : null, completedQuizRevision: passed ? target.quizRevision : null } };
    }) };
  return { input, target, paths, receipt, quizRevisionId };
}

test("assessment scope and receipt bind review order, native UUIDs, lesson and stored revision transitions", () => {
  const { input, target, paths, receipt } = selection();
  const issued = Math.floor(Date.now() / 1000), expires = issued + 60;
  const selector = (target.actorId + target.courseId + target.lessonId).replaceAll("-", "");
  const cookie = ["v2", input.epoch, input.stage, issued, expires, "a".repeat(32), selector, "b".repeat(64)].join(".");
  const permit = { stage: input.stage, epoch: input.epoch, expires, cookie };
  assert.equal(validateP2InteractiveBrowserInput(input), input);
  assert.equal(validateP2InteractiveBrowserPermit(permit, input), permit);
  assert.equal(p2InteractiveBrowserEntryPath(input, "learner"), paths.lessonPath);
  assert.throws(() => p2InteractiveBrowserEntryPath(input, "owner"));
  for (const update of [
    { quizRevision: 0 }, { passAnswers: target.failAnswers }, { passAnswers: [...target.passAnswers].reverse() },
    { failAnswers: [target.failAnswers[0], target.failAnswers[0]] },
  ]) assert.throws(() => validateP2InteractiveBrowserInput({ ...input, assessment: { ...target, ...update } }));
  for (const key of ["actorId", "courseId", "lessonId"]) {
    assert.throws(() => validateP2InteractiveBrowserPermit(permit, { ...input, assessment: { ...target, [key]: randomUUID() } }));
  }
  assert.equal(validateP2LessonAssessmentReceipt(receipt, target), receipt);
  const [first, second] = receipt.attempts;
  for (const invalid of [
    { ...receipt, playback: { ...receipt.playback, status: 200 } },
    { ...receipt, started: { ...receipt.started, requestId: first.requestId } },
    { ...receipt, attempts: [second, first] },
    { ...receipt, attempts: [first, { ...second, payloadRequestId: first.payloadRequestId }] },
    { ...receipt, attempts: [first, { ...second, quizRevisionId: randomUUID() }] },
    { ...receipt, attempts: [first, { ...second, progress: { ...second.progress, revision: 4 } }] },
    { ...receipt, attempts: [first, { ...second, progress: { ...second.progress, completedAt: null } }] },
  ]) assert.throws(() => validateP2LessonAssessmentReceipt(invalid, target));
});

function ownedPage({ target, paths, quizRevisionId }, scenario) {
  const questions = scenario === "wrong-display-order" ? [...target.failAnswers].reverse() : target.failAnswers;
  return `<!doctype html><main><h1>Text-only grading fixture</h1><p id="progress">Your progress will save to your account.</p>
    <section aria-labelledby="owned-assessment"><h2 id="owned-assessment">Check your understanding</h2>
      <p>Score at least 80% to complete this assessment. You can try as often as you need.</p><div id="stage"></div></section></main>
    <script>
      const fixture = ${JSON.stringify({ paths, questions, quizRevisionId, quizRevision: target.quizRevision, scenario })};
      const { paths, questions, quizRevisionId, quizRevision, scenario } = fixture;
      const stage = document.querySelector('#stage'), progress = document.querySelector('#progress');
      const post = (path, value) => fetch(path, {method:'POST', headers:{'content-type':'application/json','x-lash-csrf':'1'},body:JSON.stringify(value)});
      let lastId, trustedChangeCount = 0;
      const render = () => {
        trustedChangeCount = 0;
        stage.innerHTML = '<form>' + questions.map((question,index) => {
          const name = 'quiz-' + quizRevisionId + '-' + question.questionId;
          return '<fieldset><legend>Question ' + (index + 1) + '</legend><label><input required type="radio" name="' + name +
            '" value="poor">Needs review</label><label><input required type="radio" name="' + name + '" value="good">Correct choice</label></fieldset>';
        }).join('') + '<button type="submit">Submit answers</button></form>';
        const form = stage.querySelector('form');
        form.onchange = event => { if (event.isTrusted) trustedChangeCount++; };
        form.onsubmit = async event => {
          event.preventDefault();
          if (!event.isTrusted || trustedChangeCount !== questions.length) throw new Error('Native radio and submit actions required');
          form.querySelector('button').disabled = true;
          const fields = new FormData(form);
          const requestId = scenario === 'reused-payload' && lastId ? lastId : crypto.randomUUID();
          lastId = requestId;
          const answers = questions.map(({questionId}) => ({questionId,optionId:fields.get('quiz-' + quizRevisionId + '-' + questionId)}));
          if (scenario === 'wrong-payload') answers.reverse();
          if (scenario === 'early-progress') void fetch(paths.latestPath);
          const { attempt } = await (await post(paths.attemptsPath, {quizRevision,requestId,answers})).json();
          stage.innerHTML = '<div role="status"><h3>' + (attempt.passed ? 'Assessment passed' : 'Keep practising') + '</h3><p>' +
            attempt.correctCount + ' of ' + attempt.totalCount + ' answers correct.</p><button type="button">Try again</button></div>';
          stage.querySelector('button').onclick = event => { if (event.isTrusted) render(); };
          const latest = await (await fetch(paths.latestPath)).json();
          progress.textContent = latest.progress[0].completedAt ? 'Lesson complete. Progress saved.' : 'Progress saved to your account.';
        };
      };
      render();
      void fetch(paths.playbackPath).then(response => response.json());
      void post(paths.progressPath, {event:'lesson_started',expectedProgressRevision:0}).then(response => response.json())
        .then(() => { progress.textContent = 'Progress saved to your account.'; });
    </script>`;
}

test("owned Chromium submits two genuine graded attempts, captures all six effects, and refuses drift",
  { skip: process.env.P2_INTERACTIVE_BROWSER_OWNED_TEST !== "true" }, async () => {
    const { chromium } = await import("playwright"), root = mkdtempSync(join(tmpdir(), "owned-p2-assessment-"));
    const host = new URL(origin).hostname, key = join(root, "key.pem"), cert = join(root, "cert.pem"), sockets = new Set();
    let browser, https, proxy, serve;
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
        if (!serve || request.headers.host !== host) return response.writeHead(403).end();
        serve(request, response).catch(() => response.destroy());
      });
      const tlsPort = await bind(https);
      proxy = createHttpServer((_request, response) => response.writeHead(403).end());
      proxy.on("connect", (request, socket, head) => {
        if (request.url !== `${host}:443`) { socket.destroy(); return; }
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
      for (const scenario of ["success", "media-present", "wrong-display-order", "wrong-payload", "early-progress",
        "reused-payload", "bad-grade", "public-attempt", "bad-progress"]) {
        const fixture = selection(), { input, target, paths, receipt } = fixture, effects = [];
        const context = await browser.newContext({ proxy: { server: `http://127.0.0.1:${proxyPort}` }, ignoreHTTPSErrors: true });
        await context.addCookies([{ name: "owned-customer", value: "fixture-session", url: origin + "/" }]);
        let submitted = 0;
        const progress = (value, changed = {}) => ({ id: value.progressId, userId: target.actorId, lessonId: target.lessonId,
          enrollmentId: value.enrollmentId, maxPositionSeconds: 0, resumePositionSeconds: 0, revision: value.revision,
          completedQuizRevision: value.completedQuizRevision ?? null, completedAt: value.completedAt ?? null,
          lastWatchedAt: new Date(0).toISOString(), createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), ...changed });
        serve = async (request, response) => {
          const send = (status, headers, value) => {
            const body = typeof value === "string" ? value : JSON.stringify(value);
            response.writeHead(status, { ...headers, "content-length": Buffer.byteLength(body) }).end(body);
          };
          const sendJson = (requestId, body, status = 200, publicResponse = false) => send(status, {
            "content-type": "application/json", "x-request-id": requestId,
            ...(publicResponse ? { "cache-control": "public" } : privateCache),
          }, body);
          if (!request.headers.cookie?.includes("owned-customer=fixture-session")) return send(401, {}, "");
          if (request.url === paths.lessonPath) return send(200, { "content-type": "text/html", ...privateCache }, ownedPage(fixture, scenario));
          if (request.url === paths.playbackPath) {
            effects.push({ target: request.url, method: request.method });
            return scenario === "media-present" ? sendJson(receipt.playback.requestId, { playbackToken: "unexpected" })
              : sendJson(receipt.playback.requestId, { error: { code: "not_found", message: "This resource is unavailable." },
                requestId: receipt.playback.requestId }, 404);
          }
          if (request.url === paths.progressPath || request.url === paths.attemptsPath) {
            const chunks = [];
            for await (const chunk of request) chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks).toString());
            effects.push({ target: request.url, method: request.method, body });
            if (request.url === paths.progressPath) return sendJson(receipt.started.requestId, { progress: progress(receipt.started) });
            const selected = receipt.attempts[submitted++];
            if (!selected) return send(409, {}, "");
            const attempt = { id: selected.attemptId, lessonId: target.lessonId, quizRevisionId: selected.quizRevisionId,
              quizRevision: selected.quizRevision, mode: "graded", passingPercent: 80,
              answers: [...body.answers].sort((a, b) => a.questionId < b.questionId ? -1 : 1),
              correctCount: scenario === "bad-grade" ? 2 : selected.correctCount, totalCount: selected.totalCount,
              passed: selected.passed, completed: selected.completed, createdAt: selected.createdAt,
              results: body.answers.map(answer => ({ questionId: answer.questionId, selectedOptionId: answer.optionId,
                correctOptionId: "good", correct: answer.optionId === "good", feedback: "Private reviewed feedback." })) };
            return sendJson(selected.requestId, { attempt }, 200, scenario === "public-attempt");
          }
          if (request.url === paths.latestPath) {
            effects.push({ target: request.url, method: request.method });
            const selected = receipt.attempts[submitted - 1]?.progress;
            return selected ? sendJson(selected.requestId, { progress: [progress(selected, scenario === "bad-progress" ? { revision: 4 } : {})] })
              : send(409, {}, "");
          }
          return send(404, {}, "");
        };
        const page = await context.newPage(), watch = watchP2LessonAssessment(context, page, input);
        const expires = Math.floor(Date.now() / 1000) + 8;
        try {
          if (scenario === "success") {
            await watch.open(expires);
            await watch.wait(expires);
            for (const [index, effect] of effects.filter(effect => effect.target === paths.attemptsPath).entries()) {
              receipt.attempts[index].payloadRequestId = effect.body.requestId;
            }
            assert.deepEqual(watch.finish(), receipt);
            assert.deepEqual(effects.map(effect => effect.target), [paths.playbackPath, paths.progressPath,
              paths.attemptsPath, paths.latestPath, paths.attemptsPath, paths.latestPath]);
            assert.doesNotMatch(JSON.stringify(watch.finish()), /fixture-session|feedback|optionId|questionId/u);
            await page.evaluate(path => fetch(path), paths.latestPath);
            assert.throws(() => watch.finish(), refusal);
          } else {
            await assert.rejects(async () => { await watch.open(expires); await watch.wait(expires); }, refusal, scenario);
            assert.throws(() => watch.finish(), refusal, scenario);
          }
        } finally { await watch.close(); await context.close(); }
      }
    } finally {
      await browser?.close();
      for (const socket of sockets) socket.destroy();
      await Promise.all([proxy, https].filter(server => server?.listening).map(server => new Promise(done => server.close(done))));
      rmSync(root, { recursive: true, force: true });
    }
  });
