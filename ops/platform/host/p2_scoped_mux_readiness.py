"""Read one selected managed Mux generation under the held staging fences."""

import copy
from pathlib import Path

import migrate
import release as runtime
from p2_scoped_mux import (_PROFILE, _SHA, _UUID, _canonical, _hash, _provider, _require,
                           course_query_row, profiled_course_query, run_profiled_course_query)


_SOURCE = Path(__file__).resolve()
_SOURCE_KEY = "ops/platform/host/p2_scoped_mux_readiness.py"
_STATUS = "P2_SCOPED_MUX_READY_OBSERVED"
_ACTION_KEYS = {"attemptId", "generation", "environmentId", "uploadId", "assetId", "courseId",
                "lessonId", "playbackIdSha256"}
_ZERO = {"newWork": 0, "recovery": 0}

# Hash the playback identifier inside Postgres. It never enters the host query
# output, request parameters, application, or certification receipt.
READY_SELECT = '''SELECT a.id::text AS "attemptId", a.generation,
       a.provider_environment_id AS "environmentId", a.mux_upload_id AS "uploadId",
       a.mux_asset_id AS "assetId", c.id::text AS "courseId", l.id::text AS "lessonId",
       encode(sha256(convert_to(a.mux_playback_id,'UTF8')),'hex') AS "playbackIdSha256",
       a.status, a.is_current AS "isCurrent", a.managed_by_course AS "managedByCourse"
  FROM public.video_assets a
  JOIN public.lessons l ON l.id = a.lesson_id
  JOIN public.modules m ON m.id = l.module_id
  JOIN public.courses c ON c.id = m.course_id
 WHERE a.id = $1::uuid AND a.generation = $2::int AND a.provider_environment_id = $3
   AND a.mux_upload_id = $4 AND a.mux_asset_id = $5 AND c.id = $6::uuid AND l.id = $7::uuid
   AND a.status = 'ready' AND a.is_current IS TRUE AND a.managed_by_course IS TRUE
   AND a.deleted_at IS NULL AND a.superseded_at IS NULL
   AND a.mux_playback_id IS NOT NULL AND a.mux_playback_id <> ''
   AND c.status IN ('draft', 'published') AND l.archived_at IS NULL AND m.archived_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM public.video_assets later
                    WHERE later.lesson_id = l.id AND later.generation > a.generation)'''
_READY_QUERY = profiled_course_query(READY_SELECT)


def validate_selection(value):
    _require(type(value) is dict and set(value) == _ACTION_KEYS and
             all(type(value[key]) is str and _UUID.fullmatch(value[key])
                 for key in ("attemptId", "courseId", "lessonId")) and
             type(value["generation"]) is int and 1 <= value["generation"] <= 2_147_483_647 and
             all(_provider(value[key]) for key in ("environmentId", "uploadId", "assetId")) and
             _digest(value["playbackIdSha256"]), "P2_SCOPED_MUX_READINESS_SELECTION_REQUIRED")
    return copy.deepcopy(value)


def _digest(value):
    return type(value) is str and _SHA.fullmatch(value) and value != "0" * 64


def _require_closed(plan, frontend, gateway):
    admission = gateway.get("admission")
    _require(type(frontend) is dict and set(frontend) == {"epoch", "newWork", "recovery", "active", "uncertain"} and
             frontend["epoch"] == plan["initialEpoch"] and type(admission) is dict and
             all(row.get("newWork") is False and row.get("recovery") is False for row in (frontend, admission)) and
             all(type(frontend[key]) is int and frontend[key] == 0 for key in ("active", "uncertain")) and
             all(type(admission.get(key)) is dict and set(admission[key]) == set(_ZERO) and
                 all(type(value) is int and value == 0 for value in admission[key].values())
                 for key in ("active", "uncertain")) and
             admission.get("valid") is True and type(admission.get("version")) is int and admission["version"] == 1 and
             _digest(admission.get("sha256")) and gateway.get("faultLeasePresent") is False and
             gateway.get("processSha256") == plan["gatewayProcessSha256"] and
             gateway.get("gatewayConfigurationSha256") == plan["gatewayConfigurationSha256"],
             "P2_SCOPED_MUX_READINESS_CLOSED_ZERO_REQUIRED")
    return {"frontendEpoch": frontend["epoch"], "gatewayStateSha256": admission["sha256"]}


def _ready_row(action):
    return {**action, "status": "ready", "isCurrent": True, "managedByCourse": True}


def require_ready_row(action, row):
    _require(type(row) is dict and row == _ready_row(action) and type(row["generation"]) is int and
             row["isCurrent"] is True and row["managedByCourse"] is True,
             "P2_SCOPED_MUX_READINESS_READY_ROW_REQUIRED")


def require_held_receipt(plan, receipt, status, extra, gateway_admission=None):
    fields = {"version", "qualificationTargetProfile", "status", "environment", "planSha256", "scopedAction",
              "certificationActionId", "candidateSha256", "frontendEpoch", "gatewayProcessSha256", "gatewayStateSha256",
              "courseMigrationImage", "courseDatabaseReceiptSha256", "databaseIdentitySha256",
              "readOnly", "nativeEnabled", "muxProviderTouched", "trafficAuthorized", "releaseAccepted"} | extra
    _require(type(receipt) is dict and set(receipt) == fields and type(receipt["version"]) is int and
             receipt["version"] == 2 and receipt["status"] == status and
             _canonical(receipt["scopedAction"]) == _canonical(plan["scopedAction"]) and
             all(receipt[key] == plan[key] for key in ("environment", "planSha256", "certificationActionId",
                                                       "candidateSha256", "gatewayProcessSha256")) and
             receipt["frontendEpoch"] == plan["initialEpoch"] and receipt["readOnly"] is True and
             all(receipt[key] is False for key in ("nativeEnabled", "muxProviderTouched", "trafficAuthorized", "releaseAccepted")) and
             type(receipt["courseMigrationImage"]) is str and "@sha256:" in receipt["courseMigrationImage"] and
             all(_digest(receipt[key]) for key in ("gatewayStateSha256", "courseDatabaseReceiptSha256",
                                                    "databaseIdentitySha256")) and
             (gateway_admission is None or receipt["gatewayStateSha256"] == gateway_admission.get("sha256")),
             "P2_SCOPED_MUX_READINESS_RECEIPT_REQUIRED")
    migrate.require_profile(_PROFILE, receipt)


def require_receipt(plan, receipt, gateway_admission=None):
    action = validate_selection(plan["scopedAction"])
    require_held_receipt(plan, receipt, _STATUS, {"readyRowSha256"}, gateway_admission)
    _require(receipt["readyRowSha256"] == _hash(_canonical(_ready_row(action))),
             "P2_SCOPED_MUX_READINESS_RECEIPT_REQUIRED")


class P2HeldMuxReadStage:
    def __init__(self, broker, *, mode, source_key, source):
        from p2_certification_parent import P2CertificationScope, P2ProfiledCertificationBroker

        _require(type(broker) is P2ProfiledCertificationBroker and type(broker.scope) is P2CertificationScope and
                 broker.certification_profile() == broker.scope._expected_profile == _PROFILE and
                 broker.initial["sourceSha256"].get(source_key) == _hash(source.read_bytes()),
                 "P2_SCOPED_MUX_READINESS_PARENT_REQUIRED")
        self.broker, self.scope = broker, broker.scope
        self.plan = self.scope.certification_plan
        _require(self.plan["mode"] == mode and self.plan["startState"] == "already-closed",
                 "P2_SCOPED_MUX_READINESS_PARENT_REQUIRED")
        self.attempted = False

    def _fence(self):
        from p2_certification_parent import _profiled_plan_hash

        broker, scope = self.broker, self.scope
        broker.check()
        _require(broker.external_armed is True and broker.guard_arm_verified is True and
                 broker.scope is scope and broker.observer is scope._physical_observer and
                 broker.initial["certificationPlan"] == self.plan == scope.certification_plan and
                 _profiled_plan_hash(self.plan) == self.plan["planSha256"] and
                 broker._runtime_processes() == broker.process_snapshot,
                 "P2_SCOPED_MUX_READINESS_PARENT_CHANGED")
        scope.require_release(broker.selected, broker.jobs)
        scope.require_configuration(broker.configuration)
        scope.require_frontend(broker.selected, broker.jobs["frontend"])
        _require(broker.require_scoped_native_off().get("nativeEnabled") is False,
                 "P2_SCOPED_MUX_READINESS_NATIVE_OFF_REQUIRED")
        return self.closed_fence()

    def closed_fence(self):
        broker = self.broker
        return _require_closed(self.plan, broker.observer.probe("observe")["admission"], broker._gateway_current())

    def _begin(self):
        _require(not self.attempted, "P2_SCOPED_MUX_READINESS_ALREADY_ATTEMPTED")
        self.attempted = True
        return self._fence()

    def _environment(self, service):
        broker = self.broker
        name = service + ".env"
        configuration = migrate.read_input(broker.configuration, name, 65_536)
        _require(_hash(configuration) == broker.initial["configurationSha256"][name],
                 "P2_SCOPED_MUX_READINESS_COURSE_CONFIGURATION_CHANGED")
        return runtime.environment_values(configuration, "staging", service, broker.jobs, expected_profile=_PROFILE)

    def _query(self, script, parameters, selected_environment):
        from current_databases import read_certification_api_proof

        broker = self.broker
        _, proof = read_certification_api_proof(broker.api_proof, self.scope, broker.selected, broker.jobs,
                                                expected_profile=_PROFILE)
        _require(self._environment("course-api").get("MUX_ENVIRONMENT_ID") == selected_environment,
                 "P2_SCOPED_MUX_READINESS_ENVIRONMENT_REQUIRED")
        course = broker.jobs["course"]
        image, target = course["image"], course["job"]["target"]
        image_receipt = proof["databases"]["course"]
        _require(image == broker.selected["artifacts"]["courseMigration"]["image"] == image_receipt["image"],
                 "P2_SCOPED_MUX_READINESS_COURSE_IMAGE_REQUIRED")
        result = run_profiled_course_query(self.scope, image, target,
                    broker.initial["credentials"]["COURSE_STAGING_DATABASE_URL"], script, parameters)
        identity, row = course_query_row(result, target, profiled=True)
        return row, {"courseMigrationImage": image, "courseDatabaseReceiptSha256": image_receipt["receiptSha256"],
                     "databaseIdentitySha256": _hash(_canonical(identity))}

    def _finish(self, fence, status, binding):
        _require(self._fence() == fence, "P2_SCOPED_MUX_READINESS_FENCE_CHANGED")
        return {"version": 2, "qualificationTargetProfile": copy.deepcopy(_PROFILE), "status": status,
                "scopedAction": copy.deepcopy(self.action), **fence,
                **{key: self.plan[key] for key in ("environment", "planSha256", "certificationActionId",
                                                 "candidateSha256", "gatewayProcessSha256")}, **binding,
                "readOnly": True, "nativeEnabled": False, "muxProviderTouched": False, "trafficAuthorized": False,
                "releaseAccepted": False}


def readiness_parameters(action):
    return [action[key] for key in ("attemptId", "generation", "environmentId", "uploadId", "assetId",
                                   "courseId", "lessonId")]


class P2ScopedMuxReadinessStage(P2HeldMuxReadStage):
    def __init__(self, broker):
        super().__init__(broker, mode="mux-readiness", source_key=_SOURCE_KEY, source=_SOURCE)
        self.action = validate_selection(self.plan["scopedAction"])

    def observe(self):
        fence = self._begin()
        row, identity = self._query(_READY_QUERY, readiness_parameters(self.action), self.action["environmentId"])
        require_ready_row(self.action, row)
        receipt = self._finish(fence, _STATUS, {**identity, "readyRowSha256": _hash(_canonical(row))})
        require_receipt(self.plan, receipt)
        return receipt
