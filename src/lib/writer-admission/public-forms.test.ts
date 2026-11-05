import assert from "node:assert/strict";
import test from "node:test";
import { createPublicFormActions } from "@/lib/forms/public-actions";
import { processContactPopupSubmission } from "@/lib/contact-popup/contact-popup-submission";
import {
  signupForCourse,
  type CourseSignupDependencies,
} from "@/lib/courses/signup";
import { runActionWriterAdmission } from "./action";
import { createWriterAdmissionRunner } from "./runtime";
import { interactiveAdmissionFixture } from "./interactive-fixture";

const inquiry = {
  name: "Owned Person",
  email: "owned@example.invalid",
  message: "Owned inquiry",
};
const training = {
  ...inquiry,
  phone: "4165550123",
  privacyPolicyConsent: true,
  programSlug: "owned",
  programTitle: "Owned",
};
const popup = { email: "popup@example.invalid", marketingConsent: true };
const saved = { submissionId: "owned-submission", contactId: "owned-contact" };
const unavailable = {
  success: false,
  error: "This operation is temporarily unavailable. Please retry shortly.",
};

test("closed public form admission rejects every producer before persistence and email effects", async () => {
  const f = interactiveAdmissionFixture();
  f.state.open = false;
  const effects: string[] = [];
  const actions = createPublicFormActions({
    run: f.run,
    recordInquiry: async () => {
      effects.push("inquiry");
      return saved;
    },
    recordTraining: async () => {
      effects.push("training");
      return saved;
    },
    processContactPopup: async () => {
      effects.push("popup");
      return { status: "preferences_saved", submissionId: "owned" };
    },
    sendEmails: async () => {
      effects.push("email");
    },
  });
  assert.deepEqual(await actions.submitGeneralInquiry(inquiry), unavailable);
  assert.deepEqual(await actions.submitTrainingContact(training), unavailable);
  assert.deepEqual(await actions.submitContactPopup(popup), unavailable);
  assert.deepEqual(effects, []);
  assert.deepEqual(f.events, []);
});

test("public forms persist before email and settle only after delivery", async () => {
  for (const type of ["inquiry", "training", "popup"] as const) {
    const f = interactiveAdmissionFixture();
    const effect = (stage: string) => {
      assert.equal(f.events[0], "admitted");
      assert.equal(f.state.finished, false);
      f.events.push(stage);
    };
    const actions = createPublicFormActions({
      run: f.run,
      recordInquiry: async () => {
        effect("persist");
        return saved;
      },
      recordTraining: async () => {
        effect("persist");
        return saved;
      },
      processContactPopup: async () => {
        effect("persist-and-deliver");
        return { status: "preferences_saved", submissionId: "owned" };
      },
      sendEmails: async () => {
        effect("email");
      },
    });
    const result =
      type === "inquiry"
        ? await actions.submitGeneralInquiry(inquiry)
        : type === "training"
          ? await actions.submitTrainingContact(training)
          : await actions.submitContactPopup({
              ...popup,
              email: `${type}-success@example.invalid`,
            });
    assert.deepEqual(result, { success: true });
    assert.equal(f.state.uncertain, false);
    assert.deepEqual(
      f.events,
      type === "popup"
        ? ["admitted", "persist-and-deliver", "settled"]
        : ["admitted", "persist", "email", "settled"],
    );
  }
});

test("caught persistence and email errors retain uncertainty and sanitized action results", async () => {
  const error = new Error("owned-private-marker");
  for (const stage of ["persist", "email", "popup"] as const) {
    const f = interactiveAdmissionFixture();
    const actions = createPublicFormActions({
      run: f.run,
      recordInquiry: async () => {
        if (stage === "persist") throw error;
        return saved;
      },
      sendEmails: async () => {
        if (stage === "email") throw error;
      },
      processContactPopup: async () => {
        throw error;
      },
    });
    const result =
      stage === "popup"
        ? await actions.submitContactPopup({
            ...popup,
            email: "popup-failure@example.invalid",
          })
        : await actions.submitGeneralInquiry(inquiry);
    assert.deepEqual(result, unavailable);
    assert.equal(f.state.uncertain, true);
  }
});

test("validation errors settle cleanly and admission off preserves original saved-email warning", async () => {
  const f = interactiveAdmissionFixture();
  let effects = 0;
  const actions = createPublicFormActions({
    run: f.run,
    recordInquiry: async () => {
      effects++;
      return saved;
    },
  });
  assert.ok(
    (await actions.submitGeneralInquiry({ ...inquiry, email: "bad" }))
      .fieldErrors?.email,
  );
  assert.equal(effects, 0);
  assert.equal(f.state.uncertain, false);
  const off = createPublicFormActions({
    run: createWriterAdmissionRunner({ getConfiguration: () => null }),
    recordInquiry: async () => saved,
    sendEmails: async () => {
      throw new Error("owned");
    },
  });
  assert.match(
    (await off.submitGeneralInquiry(inquiry)).error!,
    /submission was saved/,
  );
});

test("popup non-blocking admin delivery failure waits for its sibling and cannot settle cleanly", async () => {
  const f = interactiveAdmissionFixture();
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = runActionWriterAdmission(
    "new-work",
    () =>
      processContactPopupSubmission(popup, {
        resolveOffer: async () => ({ status: "disabled" }),
        recordSubmission: async () => saved,
        sendAdminEmail: async () => {
          entered();
          await held;
          throw new Error("owned-private-marker");
        },
        sendGenericWelcomeEmail: async () => {},
        processOfferEmailJob: async () => {
          throw new Error("unexpected");
        },
        logError: () => {},
        logWarn: () => {},
      }),
    () => null,
    f.run,
  );
  await started;
  assert.equal(f.state.finished, false);
  release();
  assert.equal(await pending, null);
  assert.equal(f.state.uncertain, true);
});

function signupDependencies(
  overrides: Partial<CourseSignupDependencies> = {},
): CourseSignupDependencies {
  return {
    getCourse: async () => ({
      _id: "owned",
      slug: "owned",
      title: "Owned",
      introduction: "Owned",
      modules: [{ _key: "owned", title: "Owned" }],
    }),
    getSecret: () => "owned-secret-that-is-at-least-thirty-two-characters",
    getToken: async () => undefined,
    checkRateLimit: async () => true,
    recordSignup: async () => {},
    setCookie: async () => {},
    now: () => Date.now(),
    logError: () => {},
    ...overrides,
  };
}

test("legacy signup admission includes rate-limit, persistence and cookie effects; caught failures remain uncertain", async () => {
  for (const stage of [
    "checkRateLimit",
    "recordSignup",
    "setCookie",
  ] as const) {
    const f = interactiveAdmissionFixture();
    let effects = 0;
    const dependencies = signupDependencies({
      [stage]: async () => {
        assert.equal(f.events[0], "admitted");
        effects++;
        throw new Error("owned-private-marker");
      },
    });
    const result = await runActionWriterAdmission(
      "new-work",
      () => signupForCourse({ ...training, courseId: "owned", marketingConsent: false }, dependencies),
      () => unavailable,
      f.run,
    );
    assert.deepEqual(result, unavailable);
    assert.equal(effects, 1);
    assert.equal(f.state.uncertain, true);
  }
});
