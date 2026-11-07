// Explicit staging certification component. No ambient credentials or automatic reopening.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, lstatSync, realpathSync, readFileSync, writeFileSync, fsyncSync, linkSync, unlinkSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { changeFrontendAdmission } from "./frontend-admission.mjs";
import { frontendAdmissionTargetSha256 } from "./frontend-admission-bootstrap.mjs";
import { requireQualificationTargetProfile, STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE } from "./qualification-target-profile.mjs";

export const P2_LIFECYCLE_NATIVE_PROJECT = "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM";
export const P2_LIFECYCLE_NATIVE_SCHEDULE = Object.freeze({ path: "/api/cron/account-lifecycle", schedule: "* * * * *" });
export const P2_NATIVE_FEATURE_NAMES = Object.freeze(["INTEGRATION_CUSTOMER_ACCESS_ENABLED", "INTEGRATION_COURSE_READS_ENABLED", "INTEGRATION_CHECKOUT_ENABLED",
  "INTEGRATION_ENTITLEMENT_RECOVERY_ENABLED", "INTEGRATION_COMMUNITY_READS_ENABLED", "INTEGRATION_COMMUNITY_WRITES_ENABLED", "INTEGRATION_LEARNING_ROUTES_ENABLED",
  "CUSTOMER_AUTH_ENABLED", "CUSTOMER_ACCOUNT_LIFECYCLE_ENABLED", "CUSTOMER_ACCOUNT_LIFECYCLE_RECOVERY_ENABLED"]);
const reviewedSource = {
  "src/app/api/cron/account-lifecycle/route.ts": "a42e9786c20525a9d2a1a6c574913f841d14c37ab9ce54e00f2ad15c424b1a1b",
  "src/lib/customer-lifecycle/cron.ts": "019f2a5c7b76bbd812fa0663d88279d0709670b0590a7f741ad6bdfa0bc82786",
  "src/lib/customer-lifecycle/context.ts": "c88a1cc943fc8403e4aa8ff225a79cd2c86746d605ae41261c4457574a990a24",
  "src/lib/customer-lifecycle/worker.ts": "6ba8a493f9267bab172cbce9899644a4c298758a8ada5e5d5f1aa09ef6d7f90e",
  "src/lib/customer-lifecycle/store.ts": "6dd02a6006432fbfe4184dd44e58ffbbeae28760df2a9a355328297d36d42bcc",
  "src/lib/writer-admission/runtime.ts": "b3939e6cc76c028137b7e28cb21c0bf89e36a8d67c2b5e6503c20aebb032c376",
  "src/lib/writer-admission/context.ts": "79999820266972cbe58881ce58099198c5d47de8461808ffa002e99b8d3dee38",
  "src/lib/writer-admission/config.ts": "da308d0aef19c443d0f4d1ee7f52244ce11e60aee943ebbadd576b097cbc3c1b",
  "src/lib/api-integration/account-lifecycle-client.ts": "756fa4eb0c5ef24cc9b8143855cae64d7eeaaa4e3c3e32a06382412272a0ad3b",
  "ops/platform/frontend-admission.mjs": "9ebc4b95fced781a4150d4bca2fab9e01ef9189a839cbe6d6c782c1e5a6bba34",
  "ops/platform/frontend-admission.sql": "b8ec48242871a6e44fef415b127709e9b107a60751e47bc0fa328b99244ab6ab",
  "src/lib/customer-lifecycle/native-trace.ts": "3c88d9f7e81e9951b3e0df67f2401bdbe8c973c63823ceb9eea2b58ec3a3bf08",
  "src/app/api/internal/release-probe/handler.ts": "e2ee81c21bc158a19eeb0fb5ca14f4f35b7828919fc02f4272341bbefd3835c9"
};
const reviewedScopedSource = {
  ...reviewedSource,
  "src/lib/customer-lifecycle/cron.ts": "1b2c99f2627a3e6dc32cb6c0b676cfbce7bfd322b911b35b6fc55a7a2831b289",
  "src/lib/customer-lifecycle/store.ts": "55af0e8385428f92177a69239aa615f97f611c47aea1077bb8fc49fa7f99d572",
  "src/app/api/internal/release-probe/handler.ts": "f8ee3d196736f55d74f233e6f15ed232b59bb50695a78f0d97704a72b38198b3"
};
const reviewedInteractiveSource = {
  ...reviewedScopedSource,
  "src/lib/writer-admission/runtime.ts": "82304625d3d26944ab3d4b2bba9c147d82aeadc35b7008a8cd5db8a13ed54784",
  "ops/platform/frontend-admission.mjs": "a12d999e243de1269b7ad9d844fab44133a87ad24c831eb735e528428249a8b4"
};
const reviewedInteractiveDependencies = {
  "src/lib/writer-admission/interactive-proof.ts": "fc832f7cbb07f270861e2753a8bf62253109240fb7ce0135097bdf834526de93",
  "src/proxy.ts": "790b076d78dc67a992a9662bd0d0f3b54b2ea5a23965a2d8be881e20099a0a80",
  "src/app/admin/auth-actions.ts": "e2420cae789e8239f44058ba66d82d46fd7bfcf0b08c69ea59c1dab8ecd54de1"
};
const reviewedGatewayProofDependencies = {
  ...reviewedInteractiveDependencies,
  "src/lib/writer-admission/interactive-proof.ts": "a7b55a52a4194f67f90058fd2e17939f63af9f0669b1f9601f1bb80f24accc9f",
  "src/lib/api-integration/gateway-transport.ts": "69fdca4874a44faad96318151270dbf37948becabed33c5255d1f6516ce4cbf8"
};
const reviewedLifecyclePermitSource = {
  ...reviewedInteractiveSource,
  "src/lib/writer-admission/runtime.ts": "b787f2e9b0746a342d0dac6e855c5e4510670772d5357ac516e7ac42998b6e23",
  "src/lib/writer-admission/context.ts": "5cc5f69904ef7b76a079f0c8525616370edcd57b5b4c9f0364c2053812eb3d25"
};
const reviewedLifecyclePermitDependencies = {
  ...reviewedGatewayProofDependencies,
  "src/lib/writer-admission/interactive-proof.ts": "bcdc988d36f15be015af59c277f337d4cff6936f01f3c3a14ec8af798b3b4e8c",
  "src/lib/customer-lifecycle/handler.ts": "88f53c68378e5931123026d0f245a629a5a052b06fbec50cf303b60ddf047c1d",
  "src/app/(site)/account/page.tsx": "e159f2ceb622a9b56bc31afcdb09e2afdf8d2e91c7ebacfa1455c43c51e075c0"
};
const reviewedIdentityPermitDependencies = {
  ...reviewedLifecyclePermitDependencies,
  "src/lib/writer-admission/interactive-proof.ts": "f66a93e2e154704d84e4527f9f7909609531bceab1a4830cc72697ab9d351721"
};
const reviewedCustomerIdentitySource = {
  ...reviewedLifecyclePermitSource,
  "src/lib/writer-admission/runtime.ts": "7686aa5ec15b490a70416b418bfc8c7978f6baa296065cac9994e58192a76538",
  "src/lib/writer-admission/context.ts": "c98e8c7aeaf496c8b530de186f820729f9376825391b49873cf03ab9f13c0efb"
};
const reviewedCustomerIdentityDependencies = {
  ...reviewedIdentityPermitDependencies,
  "src/lib/writer-admission/interactive-proof.ts": "50895e6b669315f9e53ea1cc12d055a10a8dd3c67de9c01edd7392342168b73e",
  "src/lib/customer-auth/config.ts": "0f265ff401c6f591fd293d013bbe708ca24768ab664ec26180b52478ac1d94d8",
  "src/lib/customer-auth/handler.ts": "a680e9f00b040693a1bec437c5fd3d414a70a01ba063e71b609797025d65b224",
  "src/lib/customer-auth/store.ts": "5e1e765f11bf283f48ae52a64b823d9db6710c4fc419d17b881f38faa6b8b2ff"
};
const reviewedFirstIdentitySource = {
  ...reviewedCustomerIdentitySource,
  "src/lib/writer-admission/runtime.ts": "84dc3584ab331c053ff2306a8072f0acf8f5e874dddc451b3f06eae7e8f5d2be",
  "src/lib/writer-admission/context.ts": "30096a475be5186f7fdb77d9732431041ab3c5cc36e8ee781c708e21d8b946e7"
};
const reviewedFirstIdentityDependencies = {
  ...reviewedCustomerIdentityDependencies,
  "src/lib/writer-admission/interactive-proof.ts": "5cfa1fe15fc649af48707dff3d5d8fb374ead3d223d5b075e3dcac63b4ede752",
  "src/lib/customer-auth/config.ts": "343de61716d134729d3a1b222be36fd88f3debf94a20c542c2a65dbebfceac56",
  "src/lib/customer-auth/handler.ts": "c73fcb0de69521e6bff7a1a1ffc6e57269cd6ce7423869b742f20fe20eae4dff",
  "src/lib/customer-auth/store.ts": "af6961f2961bf9cc2ecc63663d85e48f06fbf0d6d343767dcc1d7861437be942"
};
const reviewedAuthoringSource = {
  ...reviewedFirstIdentitySource,
  "src/lib/writer-admission/runtime.ts": "3709464c90ea99de3fc493920adb7a7e384840db5c2038166c0f9a007866bb75",
  "src/lib/writer-admission/context.ts": "9f7df174f4d630dde83d7f7ed259910431b1a6a083d674936418c9e434c6274b"
};
const reviewedAuthoringDependencies = {
  ...reviewedFirstIdentityDependencies,
  "src/lib/writer-admission/interactive-proof.ts": "0417618605b72763acdf1b6f1a4287405d1793c0a5ea580fd577448aa7f9ac17",
  "src/lib/admin/auth-service.ts": "9563bef87fe5eb0d7a9d4c329ed0ce5d2f748f617fbe5a423e3d79fca6f2661a",
  "src/lib/api-integration/course-admin-handler.ts": "1ef72cf36cd0ef5bdc18706af734b378feec4f50a55f31deb8bc41ec68d57a38"
};
const reviewedDraftEditDependencies = {
  ...reviewedAuthoringDependencies,
  "src/lib/writer-admission/interactive-proof.ts": "525003a288a7b7f8f78de56936931d79d47967bac0e71a28dd519ebae50a510b",
  "src/lib/api-integration/course-admin-handler.ts": "f00f2791a4e13b0964a8d3ccec314cf1004162204e10e9359800b7194c8dcb78"
};
const reviewedCurriculumReorderDependencies = {
  ...reviewedDraftEditDependencies,
  "src/lib/writer-admission/interactive-proof.ts": "ff5ba423233db4e1bcc04148454c423d885d4d0e30bd08dda08dfd53250e2922",
  "src/lib/api-integration/course-admin-handler.ts": "374e312063b81af0938e60ce9da4edcbcef86a83763e74ea6f9e9c0a2cf0a1f1"
};
const reviewedCurriculumCreateDependencies = {
  ...reviewedCurriculumReorderDependencies,
  "src/lib/writer-admission/interactive-proof.ts": "b52a342c8dd92650654740cc643e17c6c1f8167815a4600cbfcafb2cada91f00",
  "src/lib/api-integration/course-admin-handler.ts": "65c8f99c3f103d02906d0fa78dd4c92fd9af9cad5ef673fdf90972a886662854"
};
const reviewedPublicationSource = {
  ...reviewedAuthoringSource,
  "src/lib/writer-admission/runtime.ts": "901015ce614396cf6a64fe6a24f9918c8f51223c3b255bac298dccfcc2099b6f",
  "src/lib/writer-admission/context.ts": "d49e458f287bef6e98438d4ae948dda6be29ff546eaacf28000edf99dbd34cc0"
};
const reviewedPublicationDependencies = {
  ...reviewedCurriculumCreateDependencies,
  "src/lib/writer-admission/interactive-proof.ts": "faa10d635e7305bd294204f2f9fb7f332aa3efbf1f69bc4a05ef73dc8de47872",
  "src/lib/api-integration/course-admin-handler.ts": "7b0db29139238f0d081f7d382e7d066411a944fb77fc3598d80f2a33b1c86c52"
};
const reviewedPortableTextDependencies = {
  ...reviewedPublicationDependencies,
  "src/lib/api-integration/course-admin-handler.ts": "337837f0808362304c8f7ce6f81e3a3d1761f8be233c135efcf2f15bfc00e9bb"
};
const reviewedQuizAuthoringSource = {
  ...reviewedPublicationSource,
  "src/lib/writer-admission/context.ts": "5f528870fc48459b48467a609b6868289e4e2c1855e1a96f514eb27286361754"
};
const reviewedQuizAuthoringDependencies = {
  ...reviewedPortableTextDependencies,
  "src/lib/writer-admission/interactive-proof.ts": "26c978e329a45771c9f9fbb4aefa457d02c10246c87509c1e22d0bc80daff7ff",
  "src/lib/api-integration/course-admin-handler.ts": "b813be21cbcbc374ad37f2455e383a5eeb58c10da042ace6a8eb67bb43eedc01"
};
const reviewedFreeEnrollmentDependencies = {
  ...reviewedQuizAuthoringDependencies,
  "src/lib/writer-admission/interactive-proof.ts": "13aa0012b15612582a197761772662aefad990f97beccc6d1f9b18cc19ffb083",
  "src/lib/api-integration/academy-handler.ts": "ce8d43358fe664bc38ed732d9e1f67e162c524dcb68632454c42faa19585b1e0",
  "src/components/learning/course-detail.tsx": "6720f91d0a09ca9fcb272a16295ec642b29e24c85237978fe2bc50d53ae6c628",
  "src/components/learning/free-enrollment.tsx": "3988dd35931612f3152c438f59cd210693f8d13e02739bed404cc307b2363175",
  "src/app/(site)/courses/[slug]/page.tsx": "e130fd52c62c86740fa20a5cb180c2a4833b42e637d6b577af1937de152c53e8"
};
const reviewedPaidGrantSource = {
  ...reviewedQuizAuthoringSource,
  "src/lib/writer-admission/context.ts": "90d5478af92d5e465837f7fd0a3eda27773b0fb5e51d8e2260f3bcdf8bd6191b",
  "src/lib/writer-admission/runtime.ts": "4c66800a1dd4b79f3dccc643c68a9ba9842fe7eb5add34b1e924f42f85f5aa1c"
};
const reviewedPaidGrantDependencies = {
  ...reviewedFreeEnrollmentDependencies,
  "src/lib/writer-admission/interactive-proof.ts": "42765835c788358b6ae36055fb6e5b99e2df19da8b6c235b8559d044c92a5f22",
  "src/lib/admin/auth-service.ts": "66d21e9eefaa2704ea01874cf76954873d8afbfa816ae043567b6c55a608dfc6",
  "src/lib/course-support/manual-grant-handler.ts": "59969113a31bc2e610b3422dfdebbbc41dde430c1b406516a74f6983553020fc",
  "src/components/admin/course-authoring/manual-grant-form.tsx": "6812f6409c734b46aa268aa3d6c060b5a99853e422ac1b5fb5790d49732472e8",
  "src/app/admin/(protected)/courses/[courseId]/manual-grants/page.tsx": "296b9483cea98346c4e761a36a7ec6fe99b0b32204bfa10fed2e81eac996ec5d"
};
const reviewedPaidArchiveSource = {
  ...reviewedPaidGrantSource,
  "src/lib/writer-admission/context.ts": "d1d10fe63144d96a0acaebffdae47698b3d28103de4c79f440ee0871f943e5fc"
};
const reviewedPaidArchiveDependencies = {
  ...reviewedPaidGrantDependencies,
  "src/lib/writer-admission/interactive-proof.ts": "da92630f5cde702bd8ac6a8b7001b26512a73b78c4c6c8bfbdf7949869655bea",
  "src/lib/api-integration/course-admin-handler.ts": "08c4adeffbe6a1bdf168e9f2baab6187a724d9ca57b6685d963a0a4956daeac8",
  "src/components/admin/course-authoring/course-workspace.tsx": "2f53287bc00b5159eaa971b50366b8e5c13b3c57ab29eb6de6749a475a4dca11",
  "src/app/admin/(protected)/courses/[courseId]/page.tsx": "0857b31b2dffdf6bb7ac8460d1736dcd2a3738ba5273194ae799bbe7e48360fd"
};
const reviewedPaidRepublishSource = {
  ...reviewedPaidArchiveSource,
  "src/lib/writer-admission/context.ts": "443498852b80c1eb9787a86a2bfd1a84e659fd40ea3a7aeb350dd91cc41057e1"
};
const reviewedPaidRepublishDependencies = {
  ...reviewedPaidArchiveDependencies,
  "src/lib/writer-admission/interactive-proof.ts": "596bbc4c7af8605357dd874b86d906543f7dd43d8b2e1bf9e0559781616274dc",
  "src/lib/api-integration/course-admin-handler.ts": "e413f9dc9950e5113e8f38301b6717f08c29908aa73f85d7e938536702247b0b"
};
const reviewedPaidLearnerAccessDependencies = {
  ...reviewedPaidRepublishDependencies,
  "src/lib/writer-admission/interactive-proof.ts": "e4276aacc52ece8eb2b4be8bb3a8b7b3e14ce9b189e8c3065aafca7f098a6cb7",
  "src/lib/api-integration/course-client.ts": "cbba3d76032de509046d82b3b381a0619f7e8a40cde1c9172caca7bec329dced",
  "src/app/(site)/academy/courses/[courseId]/page.tsx": "e8459a0b396095d2e427b9c207d15992fe142e40e626e76b7c34f8dc06db1f64"
};
const reviewedPaidRevokeSource = {
  ...reviewedPaidRepublishSource,
  "src/lib/writer-admission/context.ts": "59f283de99fa0c9ddc668d5fae02e2517d0fea0d0e046857e3f671a0c31f6e22",
  "src/lib/writer-admission/runtime.ts": "d91460975458bce0feee971f4482f8c83a60a3606b87798f8254a81cdf87047b"
};
const reviewedPaidRevokeDependencies = {
  ...reviewedPaidLearnerAccessDependencies,
  "src/lib/writer-admission/interactive-proof.ts": "4e51371d3fb8394ca318fb219de822f606cc076d17d575adc2ef7ae25844fec1",
  "src/lib/admin/auth-service.ts": "eb9eb154795a2550b4cc8c545d1aeb16834a6eb3ba16c04540c5e02cbfb1255a",
  "src/lib/course-support/manual-revoke-handler.ts": "84079c89209ca24dab6268dd7c1cb967eb721d4fccbe31b682769b3340f8bfd5",
  "src/components/admin/course-authoring/manual-grant-form.tsx": "2ad4895345b2c7b1f4932ccddfea0eff5cfa976f8a9a921034fac526e1c9a635",
  "src/components/admin/course-authoring/manual-access-workspace.tsx": "e9696e18dcf269d80c686c18b9b75f6333c595388d726c3c59a0b4da04178dd1",
  "src/app/admin/(protected)/courses/[courseId]/manual-grants/page.tsx": "a87b75185b6edf400728db9b326f16b6e1a022417506aeaf4946596a2df36f48",
  "src/app/admin/(protected)/courses/[courseId]/manual-grants/revoke/page.tsx": "a20086124972d021fb020f5ea0aa13f4e77a9a86502f25501067565922400818",
  "src/app/api/admin/courses/[courseId]/manual-grants/revoke/route.ts": "0e890cca7ac3b12f3dcfb21134b4ce529dd97c939d031571aeec460ec10f969c"
};
const reviewedLessonEntryDependencies = {
  ...reviewedPaidRevokeDependencies,
  "src/lib/writer-admission/interactive-proof.ts": "eb863ce486d9ed77f6426ff530ff21762ec4e0b6e4346d710c8691d93dfd17bf",
  "src/lib/api-integration/course-client.ts": "a4de647fce510f703de6daeecd669c2d27b4ff1d50d5067199db986cdd12f351",
  "src/app/(site)/academy/courses/[courseId]/page.tsx": "47e59a65bd51e8241446940079cff8cc901f63700c2b9be36dc1de6c33b951c7",
  "src/app/(site)/academy/courses/[courseId]/lessons/[lessonId]/page.tsx": "c22f7041c8f1dd6d98cfc4c2a678403fba3e9a54179fe4e8ed8aa00d5acc74a1",
  "src/app/api/academy/lessons/[lessonId]/progress/route.ts": "87d879299cb039985b7b49e9f2d0f9e0b70f233d8d357fd85ebc3f40c0610cfd"
};
const reviewedLessonDenialDependencies = {
  ...reviewedLessonEntryDependencies,
  "src/lib/writer-admission/interactive-proof.ts": "8c4d47bf14055c277d707682bcf076c0b22e2decfe2bb9eb738fc8cf6ef74d44",
  "src/lib/api-integration/course-client.ts": "19357858a655194c17fd512ad50edb96b09a0acf60357c2f0ed8bb2b12e3339b",
  "src/app/api/academy/lessons/[lessonId]/route.ts": "710e3add0bf5b8ca0fd53a7269fb3de1f015136c903b0615dc2a1ee781026c30",
  "src/app/api/academy/lessons/[lessonId]/playback/route.ts": "65e137ec1e7e1ce51a6fb8115eb1e7fa39e867ee15cc327e93fc16a42c711952",
  "src/app/api/academy/lessons/[lessonId]/quiz/route.ts": "7bc6347d9166e42e4107c10ed4f20f09fd9ee317996583e551a1ab2d4e70b382",
  "src/app/api/academy/lessons/[lessonId]/quiz/attempts/route.ts": "a19b5ee06ce7e8ac8f8aaf8944b7efc0875c174956709f9df98a4a574ae6b75b",
  "src/app/api/academy/progress/route.ts": "aedbc6fe8c366c6c9c5dcf466cb9c18022920105a7df13fe7244d95c48e3fc32"
};
const root = realpathSync(fileURLToPath(new URL("../..", import.meta.url))), plans = new WeakSet();
const demand = ok => { if (!ok) throw new Error("P2_LIFECYCLE_NATIVE_REFUSED"); };
const digest = (value, length = 64) => typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`, "u").test(value) && !/^0+$/u.test(value);
const epoch = value => typeof value === "string" && /^[1-9][0-9]{0,17}$/u.test(value);
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value);
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
export const p2NativeHash = value => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(ordered(value))).digest("hex");
const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const same = (a, b) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
const iso = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) && Number.isFinite(Date.parse(value));

function sourcePolicy(sourceCommit) {
  demand(Object.keys(reviewedSource).length >= 8);
  const readSourceHash = file => {
    const bytes = execFileSync("git", ["--no-pager", "--no-replace-objects", "--no-optional-locks", "-c", `safe.directory=${root}`,
      "show", "--no-ext-diff", "--no-textconv", `${sourceCommit}:${file}`],
      { cwd: root, maxBuffer: 2_000_000, timeout: 10_000, stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    return p2NativeHash(bytes);
  };
  const selected = Object.fromEntries(Object.keys(reviewedSource).map(file => [file, readSourceHash(file)]));
  if (same(selected, reviewedSource) || same(selected, reviewedScopedSource)) return selected;
  const browserPolicy = [[reviewedCustomerIdentitySource, [reviewedCustomerIdentityDependencies]],
    [reviewedFirstIdentitySource, [reviewedFirstIdentityDependencies]],
    [reviewedAuthoringSource, [reviewedAuthoringDependencies, reviewedDraftEditDependencies,
      reviewedCurriculumReorderDependencies, reviewedCurriculumCreateDependencies]],
    [reviewedPublicationSource, [reviewedPublicationDependencies, reviewedPortableTextDependencies]],
    [reviewedQuizAuthoringSource, [reviewedQuizAuthoringDependencies, reviewedFreeEnrollmentDependencies]],
    [reviewedPaidGrantSource, [reviewedPaidGrantDependencies]],
    [reviewedPaidArchiveSource, [reviewedPaidArchiveDependencies]],
    [reviewedPaidRepublishSource, [reviewedPaidRepublishDependencies, reviewedPaidLearnerAccessDependencies]],
    [reviewedPaidRevokeSource, [reviewedPaidRevokeDependencies, reviewedLessonEntryDependencies, reviewedLessonDenialDependencies]]]
    .find(([source]) => same(selected, source));
  if (browserPolicy) {
    const [, expected] = browserPolicy;
    const files = new Set(expected.flatMap(variant => Object.keys(variant)));
    const hashes = Object.fromEntries(Array.from(files, file => [file, readSourceHash(file)]));
    const reviewed = expected.find(variant => Object.entries(variant).every(([file, hash]) => hashes[file] === hash));
    demand(reviewed);
    return { ...selected, ...reviewed };
  }
  if (same(selected, reviewedLifecyclePermitSource)) {
    const dependencies = Object.fromEntries(Object.keys(reviewedLifecyclePermitDependencies).map(file => [file, readSourceHash(file)]));
    demand(same(dependencies, reviewedLifecyclePermitDependencies) || same(dependencies, reviewedIdentityPermitDependencies));
    return { ...selected, ...dependencies };
  }
  demand(same(selected, reviewedInteractiveSource));
  const dependencies = Object.fromEntries(Object.keys(reviewedInteractiveDependencies).map(file => [file, readSourceHash(file)]));
  if (same(dependencies, reviewedInteractiveDependencies)) return { ...selected, ...dependencies };
  dependencies["src/lib/api-integration/gateway-transport.ts"] = readSourceHash("src/lib/api-integration/gateway-transport.ts");
  demand(same(dependencies, reviewedGatewayProofDependencies));
  return { ...selected, ...dependencies };
}
export function prepareP2LifecycleNativePlan(candidate, input, expectedProfile) {
  try {
    const publicOnly = value => { if (!value || typeof value !== "object") return; for (const [key, child] of Object.entries(value)) { demand(!/password|credential|databaseurl|access.?token|private.?key/iu.test(key)); publicOnly(child); } };
    publicOnly(candidate);
    const carriers = [candidate, candidate?.workload, candidate?.sources?.frontend, input, input?.target];
    let profileFields = {};
    if (expectedProfile === undefined) {
      demand(!carriers.some(carrier => carrier && "qualificationTargetProfile" in carrier));
    } else {
      const qualificationTargetProfile = requireQualificationTargetProfile(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE,
        { qualificationTargetProfile: expectedProfile }, ...carriers);
      profileFields = { qualificationTargetProfile };
    }
    demand(candidate?.version === (expectedProfile === undefined ? 2 : 3) && candidate.environment === "staging" && candidate.contractPhase === "p2" && candidate.integration?.state === "passed" &&
      candidate.sourceApproval?.mode === "single-operator-dispatch" && candidate.sourceApproval.operatorGithubUserId === "8996309" &&
      candidate.workload?.projectId === P2_LIFECYCLE_NATIVE_PROJECT && candidate.workload.environment === "production" &&
      candidate.sources?.frontend?.repository === "https://github.com/princessdardan/lash-her-frontend.git" && candidate.sources.frontend.requiredChecks === "passed" &&
      digest(candidate.sources.frontend.commit, 40) && /^sha256:[a-f0-9]{64}$/u.test(candidate.phase2ContractManifestSha256 ?? "") &&
      input?.version === (expectedProfile === undefined ? 1 : 2) && input.actionId === candidate.releaseId && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(input.actionId) &&
      /^dpl_[A-Za-z0-9]+$/u.test(input.deploymentId ?? "") && /^https:\/\/[a-z0-9][a-z0-9-]*\.vercel\.app$/u.test(input.deploymentUrl ?? "") &&
      digest(input.configurationRecordSha256) && epoch(input.epoch) && digest(input.producer?.producerSha256) &&
      /^[a-z][a-z0-9_]{0,62}$/u.test(input.producer.role?.name ?? "") && /^[1-9][0-9]{0,9}$/u.test(input.producer.role?.oid ?? "") &&
      /^[a-z][a-z0-9_]{0,62}$/u.test(input.owner?.name ?? "") && /^[1-9][0-9]{0,9}$/u.test(input.owner?.oid ?? "") &&
      input.owner.name !== input.producer.role.name && input.owner.oid !== input.producer.role.oid && input.target?.user !== input.producer.role.name &&
      input.targetSha256 === frontendAdmissionTargetSha256("staging", input.target) && input.finalDisposition === "disabled-and-admission-closed" &&
      Number.isInteger(input.windowSeconds) && input.windowSeconds >= 60 && input.windowSeconds <= 180 && Number.isInteger(input.drainSeconds) && input.drainSeconds >= 1 && input.drainSeconds <= 180 &&
      input.featureControls && same(Object.keys(input.featureControls).sort(), [...P2_NATIVE_FEATURE_NAMES].sort()) && Object.values(input.featureControls).every(value => typeof value === "boolean") &&
      input.featureControls.CUSTOMER_ACCOUNT_LIFECYCLE_ENABLED === true && input.featureControls.CUSTOMER_ACCOUNT_LIFECYCLE_RECOVERY_ENABLED === true &&
      Array.isArray(input.commandWitnesses) && input.commandWitnesses.length > 0 && input.commandWitnesses.length <= 32 &&
      input.commandWitnesses.every(row => uuid(row.commandId) && epoch(row.accountVersion) && ['suspend','restore','export','delete'].includes(row.action)) &&
      new Set(input.commandWitnesses.map(row => row.commandId)).size === input.commandWitnesses.length);
    const base = { version: input.version, ...profileFields, environment: "staging", actionId: input.actionId, projectId: P2_LIFECYCLE_NATIVE_PROJECT,
      sourceCommit: candidate.sources.frontend.commit, candidateSha256: p2NativeHash(candidate), phase2ContractManifestSha256: candidate.phase2ContractManifestSha256,
      sourcePolicy: sourcePolicy(candidate.sources.frontend.commit), deploymentId: input.deploymentId, deploymentUrl: input.deploymentUrl,
      configurationRecordSha256: input.configurationRecordSha256, featureControls: { ...input.featureControls }, targetSha256: input.targetSha256,
      target: { ...Object.fromEntries(["host","port","database","user","serverMajor"].map(key => [key, input.target[key]])), ...profileFields }, owner: { name:input.owner.name,oid:input.owner.oid },
      producer: {producerSha256:input.producer.producerSha256,role:{name:input.producer.role.name,oid:input.producer.role.oid}},
      initialEpoch: input.epoch, schedule: P2_LIFECYCLE_NATIVE_SCHEDULE, windowSeconds: input.windowSeconds, drainSeconds: input.drainSeconds,
      commandWitnesses: input.commandWitnesses.map(row => ({ commandId: row.commandId, accountVersion: row.accountVersion, action: row.action })),
      writerAdmissionBinding: { mode: "enforce", targetSha256: input.targetSha256, producerSha256: input.producer.producerSha256, sourceCommit: candidate.sources.frontend.commit, roleName: input.producer.role.name },
      finalDisposition: input.finalDisposition, providerQueuedInventory: null, automaticReplayAllowed: false, migrationAuthorized: false, wholeReleaseAccepted: false };
    const plan = freeze({ ...base, planSha256: p2NativeHash(base) }); plans.add(plan); return plan;
  } catch { throw new Error("P2_LIFECYCLE_NATIVE_PLAN_REFUSED"); }
}

function store(directory) {
  demand(typeof directory === "string" && resolve(directory) === directory && realpathSync(directory) === directory);
  const info = lstatSync(directory); demand(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid() && (info.mode & 0o077) === 0);
  for (let path = directory;; path = dirname(path)) { demand(!existsSync(join(path, ".git"))); if (dirname(path) === path) break; }
  const write = (name, value) => {
    demand(/^[a-z0-9][a-z0-9.-]+\.json$/u.test(name));
    const temporary = join(directory, `.${name}.${randomUUID()}`), fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); linkSync(temporary, join(directory, name));
      const parent = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { fsyncSync(parent); } finally { closeSync(parent); }
    } finally { closeSync(fd); try { unlinkSync(temporary); } catch { /* Never overwrite/delete original evidence. */ } }
  };
  return { write, exists: name => existsSync(join(directory, name)) };
}
function retained(directory, name) {
  store(directory);
  const fd = openSync(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const info = fstatSync(fd); demand(info.isFile() && info.uid === process.getuid() && (info.mode & 0o077) === 0 && info.size > 0 && info.size <= 2_000_000); return JSON.parse(readFileSync(fd, "utf8")); }
  finally { closeSync(fd); }
}

export async function observeP2LifecycleNativeLedger(plan, client, dependencies, windowEpoch = null) {
  demand(plans.has(plan) && typeof dependencies.withOwner === "function"); await dependencies.verifySession();
  const result = await dependencies.withOwner(async () => {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      const owner = (await client.query("SELECT current_user AS username,current_user::regrole::oid::text AS role_oid,(SELECT nspowner::text FROM pg_namespace WHERE nspname='frontend_admission') AS schema_owner_oid")).rows[0];
      demand(owner?.username === plan.owner.name && owner.role_oid === plan.owner.oid && owner.schema_owner_oid === plan.owner.oid);
      const policies = (await client.query("SELECT environment,target_sha256,epoch::text,new_work,recovery FROM frontend_admission.control WHERE singleton")).rows;
      demand(policies.length === 1 && policies[0].environment === "staging" && policies[0].target_sha256 === plan.targetSha256);
      const producer = (await client.query("SELECT producer_sha256,source_sha,database_role::text AS role_oid,enabled FROM frontend_admission.producers WHERE producer_sha256=$1", [plan.producer.producerSha256])).rows;
      demand(producer.length === 1 && producer[0].source_sha === plan.sourceCommit && producer[0].role_oid === plan.producer.role.oid && producer[0].enabled === true);
      const counts = (await client.query("SELECT count(*) FILTER(WHERE state='active')::int AS active,count(*) FILTER(WHERE state='uncertain')::int AS uncertain FROM frontend_admission.operations")).rows[0];
      demand(epoch(policies[0].epoch) && typeof policies[0].new_work === "boolean" && typeof policies[0].recovery === "boolean" &&
        Number.isInteger(counts?.active) && counts.active >= 0 && Number.isInteger(counts.uncertain) && counts.uncertain >= 0);
      const operations = windowEpoch === null ? [] : (await client.query(`SELECT id::text,producer_sha256,source_sha,database_role::text AS role_oid,epoch::text,kind,state,started_at,completed_at,reconciliation_sha256
        FROM frontend_admission.operations WHERE epoch >= $1::bigint ORDER BY started_at,id LIMIT 4097`, [windowEpoch])).rows;
      demand(operations.length <= 4096);
      // The admission owner deliberately has no public business-table grants.
      // Keep the same read-only snapshot and switch back to the migration
      // session's own role for the bounded command/receipt projection.
      demand(/^[a-z][a-z0-9_]{0,62}$/u.test(plan.target.user));
      await client.query(`SET LOCAL ROLE "${plan.target.user}"`);
      const commands = (await client.query(`SELECT command_id::text,account_version::text,action FROM public.customer_account_commands WHERE command_id=ANY($1::uuid[]) ORDER BY command_id`, [plan.commandWitnesses.map(row => row.commandId)])).rows;
      demand(commands.length === plan.commandWitnesses.length && commands.every(row => plan.commandWitnesses.some(expected => expected.commandId === row.command_id && expected.accountVersion === row.account_version && expected.action === row.action)));
      const deliveries = (await client.query(`SELECT command_id::text,receiver,status,attempts,acknowledged_at,lease_until FROM public.customer_account_deliveries
        WHERE command_id=ANY($1::uuid[]) ORDER BY command_id,receiver`, [plan.commandWitnesses.map(row => row.commandId)])).rows;
      demand(deliveries.length === commands.length * 2 && commands.every(command => ['course','community'].every(receiver => deliveries.filter(row => row.command_id === command.command_id && row.receiver === receiver).length === 1)));
      const orderViolations = (await client.query(`SELECT later.command_id::text AS later_command_id,prior.command_id::text AS prior_command_id,d.receiver
        FROM public.customer_account_commands later JOIN public.customer_account_deliveries d ON d.command_id=later.command_id
        JOIN public.customer_account_commands prior ON prior.user_id=later.user_id AND prior.account_version<later.account_version
        LEFT JOIN public.customer_account_deliveries pd ON pd.command_id=prior.command_id AND pd.receiver=d.receiver
        WHERE later.command_id=ANY($1::uuid[]) AND d.status='acknowledged' AND (pd.status IS DISTINCT FROM 'acknowledged' OR pd.acknowledged_at IS NULL OR pd.acknowledged_at>d.acknowledged_at) LIMIT 4097`, [plan.commandWitnesses.map(row => row.commandId)])).rows;
      demand(orderViolations.length <= 4096);
      const policy = policies[0]; return { epoch: policy.epoch, newWork: policy.new_work, recovery: policy.recovery, active: counts.active, uncertain: counts.uncertain,
        operations, commands, deliveries, orderViolations };
    } finally { await client.query("ROLLBACK"); }
  });
  await dependencies.verifySession(); return freeze(result);
}

// These are precise operator observations of provider request details, not a
// claimed runtime-log API schema or an exhaustive queue/invocation inventory.
export function validateP2NativeRequestObservation(plan, observation, windowEpoch) {
  demand(plans.has(plan) && epoch(windowEpoch) && observation?.version === 1 && observation.kind === "vercel-native-request-details"
    && observation.reviewerGithubUserId === "8996309" && observation.projectId === plan.projectId && observation.deploymentId === plan.deploymentId
    && observation.path === plan.schedule.path && observation.method === "GET" && observation.providerRequestTypeFilter === "cron"
    && typeof observation.providerRequestId === "string" && /^[A-Za-z0-9:._-]{1,200}$/u.test(observation.providerRequestId)
    && iso(observation.startedAt) && iso(observation.completedAt) && Date.parse(observation.completedAt) >= Date.parse(observation.startedAt)
    && [200,503].includes(observation.httpStatus) && observation.logScope === "this-provider-request-details"
    && (observation.admittedLogLine === null && observation.httpStatus === 503 || typeof observation.admittedLogLine === "string" && observation.admittedLogLine.length <= 2048));
  const event = observation.admittedLogLine === null ? null : JSON.parse(observation.admittedLogLine);
  demand(event === null || same(Object.keys(event).sort(), ['version','status','environment','projectId','operationId','producerSha256','sourceCommit','epoch','kind','targetSha256'].sort()) &&
    event.version === 1 && event.status === "P2_LIFECYCLE_CRON_ADMITTED" && event.environment === "staging" && event.projectId === plan.projectId &&
    uuid(event.operationId) && event.producerSha256 === plan.producer.producerSha256 && event.sourceCommit === plan.sourceCommit && event.epoch === windowEpoch && event.kind === "recovery" && event.targetSha256 === plan.targetSha256);
  // No completeness, cancellation, user-agent or header inference is admitted.
  demand(!Object.keys(observation).some(key => /complete|cancel|queue|header|secret|token|password/iu.test(key) && key !== "completedAt"));
  const fact = Object.fromEntries(['version','kind','reviewerGithubUserId','projectId','deploymentId','path','method','providerRequestTypeFilter','providerRequestId','startedAt','completedAt','httpStatus','logScope','admittedLogLine'].map(key => [key, observation[key]]));
  return freeze({ ...fact, event, observationSha256: p2NativeHash(fact) });
}

function verifier(plan, client, verifyEnvironment, verifySession) {
  let physicalPid;
  return async () => {
    await verifyEnvironment(); await verifySession();
    demand(client.connection?.stream?.encrypted === true && client.connection.stream.authorized === true && client.connectionParameters?.host === plan.target.host && Number(client.connectionParameters.port) === plan.target.port);
    const actual = (await client.query("SELECT pg_backend_pid() AS pid,current_user AS username,session_user AS session_username,current_database() AS database,current_setting('server_version_num')::int/10000 AS major")).rows[0];
    demand(actual && Number.isInteger(actual.pid) && (physicalPid === undefined || physicalPid === actual.pid) && actual.username === plan.target.user && actual.session_username === plan.target.user && actual.database === plan.target.database && actual.major === plan.target.serverMajor);
    physicalPid ??= actual.pid;
    demand((await client.query(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted AND mode='ExclusiveLock'
      AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND objsubid=1 AND classid=((hashtext($1)::bigint >> 32)&4294967295)::oid AND objid=(hashtext($1)::bigint&4294967295)::oid) AS held`, ['lash-her:private-db:migrations'])).rows[0]?.held === true);
  };
}

export async function qualifyP2LifecycleNative(input) {
  const { plan, client, directory, verifyEnvironment, verifySession, withOwner, nativeControl, observeNativeRequests } = input;
  demand(plans.has(plan) && input.confirmation === `staging/${plan.actionId}` && typeof verifyEnvironment === "function" && typeof verifySession === "function" && typeof withOwner === "function" &&
    typeof nativeControl?.observe === "function" && typeof nativeControl.observeMetadata === "function" && typeof nativeControl.setEnabled === "function" && typeof observeNativeRequests === "function");
  const receipts = store(directory); demand(!receipts.exists("p2-native-started.json") && !receipts.exists("p2-native-outcome.json"));
  const now = input.clock?.now ?? (() => performance.now()), pause = input.clock?.pause ?? sleep;
  let phase = "preflight", nativeEnableAttempted = false, nativeDisableAttempted = false, nativeDisabled = false, admissionMutationUnknown = false, windowEpoch, finalAdmission, scoped, after,
    observedRequests = [], failure = false, epoch = plan.initialEpoch, enableMutationOutcome = "not-started", disableMutationOutcome = "not-started", fenceCurrent = false;
  const failurePhases = [], recordFailure = () => { failure = true; if (!failurePhases.includes(phase)) failurePhases.push(phase); };
  const dependencies = { verifySession, withOwner };
  const verify = verifier(plan, client, verifyEnvironment, verifySession);
  const boundary = async expectedEnabled => {
    await verify(); const value = await nativeControl.observe(plan);
    demand(value.projectId === plan.projectId && value.deploymentId === plan.deploymentId && value.sourceCommit === plan.sourceCommit && value.deploymentUrl === plan.deploymentUrl &&
      value.configurationRecordSha256 === plan.configurationRecordSha256 && same(value.schedule, plan.schedule) && same(value.featureControls, plan.featureControls) &&
      same(value.writerAdmissionBinding, plan.writerAdmissionBinding) && value.nativeEnabled === expectedEnabled);
    await verify(); return value;
  };
  receipts.write("p2-native-started.json", { ...plan, status: "P2_LIFECYCLE_NATIVE_STARTED" });
  const containmentRecord = (name, value) => {
    // The already-durable started plan authorizes mandatory disable/closure.
    // Later record loss cannot justify leaving that temporary capability open.
    try { receipts.write(name, value); } catch { recordFailure(); }
  };
  try {
    sourcePolicy(plan.sourceCommit); const preflight = await boundary(false);
    receipts.write("p2-native-runtime-preflight.json", { planSha256:plan.planSha256, observation:Object.fromEntries(['projectId','deploymentId','sourceCommit','deploymentUrl','configurationRecordSha256','nativeEnabled','schedule','featureControls','writerAdmissionBinding'].map(key=>[key,preflight[key]])) });
    const start = await observeP2LifecycleNativeLedger(plan, client, dependencies);
    demand(start.epoch === epoch && start.recovery === true && start.active === 0 && start.uncertain === 0 && start.deliveries.some(row => row.status !== "acknowledged"));
    phase = "recovery-only-epoch-barrier";
    receipts.write("p2-native-recovery-only-intent.json", { planSha256: plan.planSha256, epoch, newWork: false, recovery: true });
    admissionMutationUnknown = true;
    const changed = await withOwner(() => changeFrontendAdmission(client, { environment: "staging", targetSha256: plan.targetSha256 }, epoch, { newWork: false, recovery: true }));
    epoch = windowEpoch = changed.epoch; admissionMutationUnknown = false;
    scoped = await observeP2LifecycleNativeLedger(plan, client, dependencies, windowEpoch);
    demand(scoped.epoch === epoch && scoped.newWork === false && scoped.recovery === true && scoped.active === 0 && scoped.uncertain === 0 && scoped.operations.length === 0);
    receipts.write("p2-native-recovery-only-observed.json", scoped);
    demand(scoped.deliveries.some(row => row.status !== "acknowledged"));
    phase = "enable-native"; receipts.write("p2-native-enable-intent.json", { planSha256: plan.planSha256, windowEpoch, schedule: plan.schedule });
    await verify(); nativeEnableAttempted = true; enableMutationOutcome = "unknown"; await nativeControl.setEnabled(plan, true); await boundary(true); enableMutationOutcome = "observed-enabled";
    phase = "bounded-native-window";
    const deadline = now() + plan.windowSeconds * 1000;
    while (now() < deadline) { await pause(Math.min(1000, deadline - now())); await verify(); }
  } catch { recordFailure(); }
  finally {
    // A distinct disable/closure is containment, never a retry of enable. A
    // killed process leaves its durable intent; recovery must inspect it.
    if (nativeEnableAttempted) {
      phase = "disable-native";
      try {
        await verify(); const current = await nativeControl.observeMetadata(plan);
        demand(current.projectId === plan.projectId && current.deploymentId === plan.deploymentId && current.sourceCommit === plan.sourceCommit);
        if (current.nativeEnabled !== false) { containmentRecord("p2-native-disable-intent.json", { planSha256: plan.planSha256, windowEpoch }); nativeDisableAttempted = true; disableMutationOutcome = "unknown"; await nativeControl.setEnabled(plan, false); }
        const disabled = await nativeControl.observeMetadata(plan);
        demand(disabled.projectId === plan.projectId && disabled.deploymentId === plan.deploymentId && disabled.sourceCommit === plan.sourceCommit && same(disabled.schedule, plan.schedule) && disabled.nativeEnabled === false);
        nativeDisabled = true; disableMutationOutcome = nativeDisableAttempted ? "observed-disabled" : "observed-disabled-without-mutation"; await boundary(false);
      } catch { recordFailure(); }
    }
    if (windowEpoch && !admissionMutationUnknown) {
      phase = "source-admission-closure";
      try {
        await verify(); containmentRecord("p2-native-admission-close-intent.json", { planSha256: plan.planSha256, epoch, newWork: false, recovery: false });
        admissionMutationUnknown = true;
        const closed = await withOwner(() => changeFrontendAdmission(client, { environment: "staging", targetSha256: plan.targetSha256 }, epoch, { newWork: false, recovery: false }));
        epoch = closed.epoch; admissionMutationUnknown = false;
        const deadline = now() + plan.drainSeconds * 1000;
        do {
          await verify(); after = await observeP2LifecycleNativeLedger(plan, client, dependencies, windowEpoch);
          demand(after.epoch === epoch && after.newWork === false && after.recovery === false);
          if (after.active === 0 || after.uncertain > 0 || now() >= deadline) break;
          await pause(Math.min(1000, deadline - now()));
        } while (true);
        finalAdmission = { epoch: after.epoch, newWork: after.newWork, recovery: after.recovery, active: after.active, uncertain: after.uncertain };
        containmentRecord("p2-native-closed-ledger-observed.json", after);
      } catch { recordFailure(); }
    }
  }
  phase = "provider-request-correlation";
  try {
    if (nativeDisabled && finalAdmission?.active === 0 && finalAdmission?.uncertain === 0) {
      await boundary(false);
      const observations = await observeNativeRequests(plan, windowEpoch);
      demand(Array.isArray(observations) && observations.length <= 4096);
      observedRequests = observations.map(observation => validateP2NativeRequestObservation(plan, observation, windowEpoch));
      demand(new Set(observedRequests.map(row => row.providerRequestId)).size === observedRequests.length && new Set(observedRequests.filter(row => row.event).map(row => row.event.operationId)).size === observedRequests.filter(row => row.event).length);
      receipts.write("p2-native-request-observations.json", observedRequests);
    }
  } catch { recordFailure(); }
  // Operator log inspection can take time. Never qualify a stale pre-inspection
  // project or ledger snapshot, even while the reviewed parent retains locks.
  if (nativeDisabled && finalAdmission && !admissionMutationUnknown) {
    phase = "final-closed-boundary";
    try {
      await boundary(false); after = await observeP2LifecycleNativeLedger(plan,client,dependencies,windowEpoch);
      demand(after.epoch === epoch && after.newWork === false && after.recovery === false);
      await boundary(false);
      finalAdmission = {epoch:after.epoch,newWork:after.newWork,recovery:after.recovery,active:after.active,uncertain:after.uncertain};
      fenceCurrent = true; containmentRecord("p2-native-final-ledger-observed.json",after);
    } catch { recordFailure(); finalAdmission = null; }
  }
  const correlatedRequests = observedRequests.filter(row => row.event);
  const matched = Boolean(after && correlatedRequests.length > 0 && after.operations.length === correlatedRequests.length && after.operations.every(operation =>
    operation.kind === "recovery" && operation.state === "completed" && operation.completed_at !== null && operation.reconciliation_sha256 === null && operation.epoch === windowEpoch && operation.producer_sha256 === plan.producer.producerSha256 &&
    operation.source_sha === plan.sourceCommit && operation.role_oid === plan.producer.role.oid && correlatedRequests.some(row => row.event.operationId === operation.id && row.httpStatus === 200)));
  const orderedEffects = Boolean(after && after.orderViolations.length === 0 && after.deliveries.every(row => row.status === "acknowledged" && row.acknowledged_at !== null && row.lease_until === null) &&
    scoped && after.deliveries.some(row => scoped.deliveries.some(before => before.command_id === row.command_id && before.receiver === row.receiver && before.status !== 'acknowledged' && row.attempts > before.attempts)));
  const fenced = fenceCurrent && nativeDisabled && finalAdmission?.newWork === false && finalAdmission?.recovery === false && finalAdmission.active === 0 && finalAdmission.uncertain === 0 && !admissionMutationUnknown;
  const qualified = !failure && matched && orderedEffects && fenced;
  const outcome = { version: 1, actionId: plan.actionId, sourceCommit: plan.sourceCommit, projectId: plan.projectId, deploymentId: plan.deploymentId, planSha256: plan.planSha256,
    status: qualified ? "P2_LIFECYCLE_NATIVE_QUALIFIED_FENCED" : "P2_LIFECYCLE_NATIVE_OPEN_REQUIRES_REVIEW", phase, windowEpoch: windowEpoch ?? null,
    nativeEnableAttempted, nativeDisableAttempted, enableMutationOutcome, disableMutationOutcome, failurePhases, nativeEnabled: fenceCurrent && nativeDisabled ? false : null, finalAdmission: finalAdmission ?? null,
    nativeInvocationObserved: observedRequests.length > 0, nativeLedgerCorrelationVerified: matched, orderedReceiverPersistenceVerified: orderedEffects,
    sourceAdmissionFenceVerified: fenced, providerQueuedInvocations: null, providerActiveInvocations: null, providerCancellationVerified: false,
    admissionMutationUnknown, automaticReplayAllowed: false, finalDisposition: plan.finalDisposition, wholeReleaseAccepted: false, migrationAuthorized: false };
  receipts.write("p2-native-outcome.json", outcome); return freeze(outcome);
}

export async function observeP2LifecycleNativeState(input) {
  const { plan, client, verifyEnvironment, verifySession, nativeControl } = input;
  demand(plans.has(plan) && typeof nativeControl?.observeMetadata === "function");
  const verify = verifier(plan, client, verifyEnvironment, verifySession);
  await verify(); const metadata = await nativeControl.observeMetadata(plan);
  demand(metadata.projectId === plan.projectId && metadata.deploymentId === plan.deploymentId && metadata.sourceCommit === plan.sourceCommit && same(metadata.schedule, plan.schedule));
  const ledger = await observeP2LifecycleNativeLedger(plan, client, input, String(BigInt(plan.initialEpoch) + 1n)); await verify();
  return freeze({ version:1, planSha256:plan.planSha256, native:metadata, ledger, observationOnly:true, automaticReplayAllowed:false, migrationAuthorized:false });
}

// Explicit containment after interruption. This never resumes a window, enables
// native scheduling, reopens admission, settles operations or accepts P2.
export async function containP2LifecycleNative(input) {
  const { plan, client, verifyEnvironment, verifySession, withOwner, nativeControl, directory, originalDirectory } = input;
  demand(plans.has(plan) && input.confirmation === `staging/${plan.actionId}` && epoch(input.expectedEpoch) && directory !== originalDirectory);
  const original = retained(originalDirectory,"p2-native-started.json"), preflight = retained(originalDirectory,"p2-native-runtime-preflight.json");
  demand(original.planSha256 === plan.planSha256 && original.sourceCommit === plan.sourceCommit && original.finalDisposition === plan.finalDisposition &&
    preflight.planSha256 === plan.planSha256 && same(preflight.observation.writerAdmissionBinding,plan.writerAdmissionBinding) && same(preflight.observation.featureControls,plan.featureControls) &&
    preflight.observation.deploymentId === plan.deploymentId && preflight.observation.configurationRecordSha256 === plan.configurationRecordSha256 &&
    BigInt(input.expectedEpoch) >= BigInt(plan.initialEpoch) && BigInt(input.expectedEpoch) <= BigInt(plan.initialEpoch)+2n);
  const receipts=store(directory); demand(!receipts.exists('p2-native-containment-started.json'));
  receipts.write('p2-native-containment-started.json',{version:1,planSha256:plan.planSha256,expectedEpoch:input.expectedEpoch,status:'P2_NATIVE_CONTAINMENT_STARTED',enableAllowed:false});
  const verify=verifier(plan,client,verifyEnvironment,verifySession), now=input.clock?.now ?? (()=>performance.now()), pause=input.clock?.pause ?? sleep;
  const disabledBoundary=async()=>{
    await verify();const metadata=await nativeControl.observeMetadata(plan);
    demand(metadata.projectId===plan.projectId && metadata.deploymentId===plan.deploymentId && metadata.sourceCommit===plan.sourceCommit &&
      metadata.deploymentUrl===plan.deploymentUrl && metadata.nativeEnabled===false && same(metadata.schedule,plan.schedule));
    await verify();return Object.fromEntries(['projectId','deploymentId','sourceCommit','deploymentUrl','schedule','nativeEnabled'].map(key=>[key,metadata[key]]));
  };
  let nativeDisabled=false, mutationUnknown=false, finalAdmission=null, failure=false;
  try {
    sourcePolicy(plan.sourceCommit); const actual=await observeP2LifecycleNativeState(input); demand(actual.ledger.epoch===input.expectedEpoch);
    await verify();
    if(actual.native.nativeEnabled===true) { receipts.write('p2-native-containment-disable-intent.json',{planSha256:plan.planSha256}); await nativeControl.setEnabled(plan,false); }
    await disabledBoundary();
    let selectedEpoch=actual.ledger.epoch;
    if(actual.ledger.newWork || actual.ledger.recovery) {
      receipts.write('p2-native-containment-close-intent.json',{planSha256:plan.planSha256,epoch:selectedEpoch,newWork:false,recovery:false}); mutationUnknown=true;
      const closed=await withOwner(()=>changeFrontendAdmission(client,{environment:'staging',targetSha256:plan.targetSha256},selectedEpoch,{newWork:false,recovery:false})); selectedEpoch=closed.epoch; mutationUnknown=false;
    }
    const deadline=now()+plan.drainSeconds*1000;
    do {
      await verify(); const ledger=await observeP2LifecycleNativeLedger(plan,client,input,String(BigInt(plan.initialEpoch)+1n));
      demand(ledger.epoch===selectedEpoch && ledger.newWork===false && ledger.recovery===false);
      finalAdmission={epoch:ledger.epoch,newWork:false,recovery:false,active:ledger.active,uncertain:ledger.uncertain};
      if(ledger.active===0 || ledger.uncertain>0 || now()>=deadline)break; await pause(Math.min(1000,deadline-now()));
    }while(true);
    // A disable readback before drain cannot establish the final source fence.
    sourcePolicy(plan.sourceCommit);const finalNative=await disabledBoundary();
    receipts.write('p2-native-containment-final-boundary.json',{version:1,planSha256:plan.planSha256,native:finalNative,finalAdmission});
    nativeDisabled=true;
  }catch{failure=true;}
  const outcome={version:1,planSha256:plan.planSha256,status:'P2_LIFECYCLE_NATIVE_CONTAINMENT_REQUIRES_REVIEW',nativeEnabled:nativeDisabled?false:null,finalAdmission,admissionMutationUnknown:mutationUnknown,
    sourceAdmissionFenceVerified:!failure && !mutationUnknown && nativeDisabled && finalAdmission?.active===0 && finalAdmission?.uncertain===0, nativeQualificationAccepted:false,
    providerQueuedInvocations:null,providerCancellationVerified:false,automaticReplayAllowed:false,migrationAuthorized:false};
  receipts.write('p2-native-containment-outcome.json',outcome);return freeze(outcome);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2); if (args[0] === "--plan") args.shift(); demand(args.length === 2);
    const document = path => { const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); try { const info = fstatSync(fd); demand(info.isFile() && info.size > 0 && info.size < 2_000_000); return JSON.parse(readFileSync(fd, "utf8")); } finally { closeSync(fd); } };
    process.stdout.write(`${JSON.stringify(prepareP2LifecycleNativePlan(document(args[0]), document(args[1])))}\n`);
  } catch { process.stderr.write('{"status":"P2_LIFECYCLE_NATIVE_PLAN_REFUSED"}\n'); process.exitCode = 1; }
}
