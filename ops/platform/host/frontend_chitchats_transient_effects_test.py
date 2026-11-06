"""Owned HTTPS fixture and opt-in disposable PostgreSQL16 evidence."""
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

import frontend_chitchats_transient_effects as component
import frontend_crm_shipping_retirement as shipping
import frontend_crm_shipping_retirement_test as fixture


class TransientTests(unittest.TestCase):
    setUpClass = classmethod(fixture.RetirementTests.setUpClass.__func__)
    tearDownClass = classmethod(fixture.RetirementTests.tearDownClass.__func__)
    tearDown = fixture.RetirementTests.tearDown
    clients = fixture.RetirementTests.clients

    # Reuse fixture setup only; don't inherit its unrelated test registrations.
    def setUp(self):
        fixture.RetirementTests.setUp(self)
        self.private = {"destination": {"name": "Private Person", "line1": "Private Address", "line2": "Private Unit", "city": "Private City", "province": "ON", "postalCode": "A1A 1A1", "countryCode": "CA", "email": "private-email@example.test", "phone": "private-phone"},
            "package_snapshot": {"packageType": "parcel", "totalWeightGrams": 250, "lengthCm": 20, "widthCm": 15, "heightCm": 3}}
        self.remote = {"id": "ownedShipment", "status": "pending", "order_id": "owned-public-reference", "purchase_amount": None, "value": "60.00", "value_currency": "CAD", "postage_type": "unknown",
            "weight_unit": "g", "weight": 250, "size_unit": "cm", "size_x": 20, "size_y": 15, "size_z": 3, "package_type": "parcel", "is_signature_requested": False, "is_insurance_requested": True, "description": "Private Product", "package_contents": "merchandise", "order_store": "other"}
        for left, right in (("to_name", "name"), ("to_address_1", "line1"), ("to_address_2", "line2"), ("to_city", "city"), ("to_province_code", "province"), ("to_postal_code", "postalCode"), ("to_country_code", "countryCode"), ("to_email", "email"), ("to_phone", "phone")):
            self.remote[left] = self.private["destination"][right]
        self.shipments = [self.remote]
        shipment = {key: None for key in component.COLUMNS["shipments"].split()}
        shipment.update(id="11111111-1111-4111-8111-111111111111", public_reference="owned-public-reference", provider_shipment_id="ownedShipment", provider_status="pending", status="quoted", state_version=2,
            flat_rate=False, purpose="original", quote_fingerprint="private-fingerprint", quote_expires_at="2026-11-05 12:00:00+00", signature_requested=False,
            **self.private, customs_lines=[{"description": "Private Product", "quantity": 1, "unitValueCents": 6000}], rates=[{"title": "Private Rate", "paymentAmountCents": 100}], raw_shipment=deepcopy(self.remote), provider_cost_currency="CAD")
        payload = {"merchandiseValueCents": 6000, "signatureRequested": False, "expectedShipmentStateVersion": 1}
        job = {key: None for key in component.COLUMNS["jobs"].split()}
        job.update(id="22222222-2222-4222-8222-222222222222", shipment_id=shipment["id"], type="create", status="succeeded", state_version=2,
            idempotency_sha256="d"*64, attempt_count=1, operation_payload_hash=component._operation_hash(payload), payload=payload,
            outcome_unknown=False, lease_owner_present=False, outcome_code="created", completed_at="2026-11-05 10:00:00+00")
        self.actual_rows = {"shipments": [shipment], "jobs": [job], "rateCache": [], "events": []}
        self.shipping.update(sourceCommit="f"*40, sourceInventorySha256="1"*64, requirementsSha256="2"*64)
        self.requirements = {"version": 1, "status": "FRONTEND_HISTORICAL_SOURCE_VERIFIED", "sourceCommit": "f"*40, "sourceInventorySha256": "1"*64, "requirementsSha256": "2"*64,
            "surfaceSha256": "3" * 64, "configurationRecordSha256": "4" * 64, "provenanceSha256": "5" * 64,
            "providerFamilies": [{"familyId": family, "provider": "chitchats", "sourceDisposition": "reachable", "untrackedPotentialRequests": [], "configurationConditions": [{"requirementId": family + ".original-configuration"}], "sqlIntentRequirements": [{"requirementId": family + ".durable-intents"}], "annotations": []} for family in component.FAMILIES]}
        self.private_markers += ["Private Person", "Private Address", "Private Unit", "Private City", "Private Product", "Private Rate", "private-phone", "private-fingerprint"]

    def observe(self):
        result = component.observe_scoped_effects(self.clients("chitchats", self.shipping)[0], self.shipping, self.actual_rows, self.requirements)
        output = json.dumps(result) + json.dumps(component.normalize_snapshot(self.actual_rows))
        for marker in self.private_markers:
            self.assertNotIn(marker, output)
        return result

    def test_acknowledged_unpurchased_draft_is_settled_api_effect_with_deferred_compatible_work(self):
        result = self.observe()
        self.assertEqual((result["activeExecutions"], result["uncertainEffects"]), (0, 0))
        self.assertEqual(result["effects"][0]["classification"], "acknowledged-unpurchased-quote-draft")
        self.assertTrue(result["deferredCompatibleWorkRequired"])
        self.assertFalse(result["trafficAuthorized"])
        self.assertTrue(all(method == "GET" for method, _path in self.calls))

    def test_actual_processing_lease_unknown_or_payload_mismatch_remains_unresolved(self):
        original = deepcopy(self.actual_rows["jobs"][0])
        for changes in ({"status": "processing"}, {"lease_owner_present": True}, {"lease_expires_at": "2026-11-05 12:00:00+00"}, {"outcome_unknown": True}, {"payload": {"merchandiseValueCents": 5000}}, {"attempt_count": 0}):
            self.actual_rows["jobs"][0] = {**original, **changes}
            result = self.observe()
            self.assertGreater(result["uncertainEffects"], 0)
        self.actual_rows["jobs"][0] = original

    def test_quote_draft_requires_exact_stored_and_live_body_and_value(self):
        for key, value in (("to_address_1", "another-private-address"), ("weight", 251), ("value", "60.01"), ("is_signature_requested", True)):
            original = self.remote[key]
            self.remote[key] = value
            self.assertGreater(self.observe()["uncertainEffects"], 0)
            self.remote[key] = original
        self.actual_rows["shipments"][0]["raw_shipment"]["weight"] = 251
        self.assertGreater(self.observe()["uncertainEffects"], 0)

    def test_no_persisted_provider_id_does_not_adopt_pre_ack_orphan_from_reference_only(self):
        self.actual_rows["shipments"][0]["provider_shipment_id"] = None
        result = self.observe()
        self.assertGreater(result["uncertainEffects"], 0)
        self.assertFalse(result["effects"][0]["reconciled"])

    def test_purchase_in_transit_is_known_effect_without_wait_for_delivery(self):
        row = self.actual_rows["shipments"][0]
        row.update(status="in_transit", provider_status="released", selected_postage_type="canada_post_tracked", actual_purchase_total_cents=100, purchased_at="2026-11-05 10:00:00+00")
        self.remote.update(status="released", postage_type="canada_post_tracked", purchase_amount="1.00")
        self.actual_rows["jobs"][0]["type"] = "purchase"
        result = self.observe()
        self.assertEqual((result["activeExecutions"], result["uncertainEffects"]), (0, 0))
        self.assertTrue(result["deferredCompatibleWorkRequired"])
        self.remote["status"] = "postage_requested"
        self.assertGreater(self.observe()["uncertainEffects"], 0)

    def test_persisted_delete_receipt_is_required_in_addition_to_current_absence(self):
        self.shipments = []
        self.shipping["expectedProviderShipmentIds"] = []
        row = self.actual_rows["shipments"][0]
        row["status"] = "abandoned"
        job = self.actual_rows["jobs"][0]
        self.assertGreater(self.observe()["uncertainEffects"], 0)
        job.update(type="cleanup", outcome_code="provider_deleted")
        self.assertEqual(self.observe()["uncertainEffects"], 0)
        job["outcome_unknown"] = True
        self.assertGreater(self.observe()["uncertainEffects"], 0)

    def test_untracked_c07_probe_gap_is_not_closed_by_empty_stable_inventory_or_cache(self):
        self.actual_rows = {key: [] for key in component.COLUMNS}
        self.shipments = []
        self.shipping["expectedProviderShipmentIds"] = []
        self.shipping["sourceCommit"] = self.requirements["sourceCommit"] = component.C07_SOURCE
        draft = self.requirements["providerFamilies"][0]
        draft["untrackedPotentialRequests"] = [{"requirementId": "chitchats.drafts.accepted-request-completeness", "requestKinds": ["flat-rate-probe-before-acknowledgement"]}]
        draft["annotations"] = [{"file": file, "sha256": digest} for file, digest in component.C07_PROBE_BLOBS.items()]
        result = self.observe()
        self.assertEqual(result["knownUncertainEffects"], 0)
        self.assertIsNone(result["uncertainEffects"])
        self.assertIsNone(result["activeExecutions"])
        self.assertEqual(len(result["sourceGaps"]), 1)
        draft["untrackedPotentialRequests"] = []
        with self.assertRaisesRegex(ValueError, "C07_UNTRACKED"):
            self.observe()

    def test_exact_probe_body_identifies_origin_shape_but_cannot_invent_request_receipt(self):
        self.actual_rows = {key: [] for key in component.COLUMNS}
        self.shipping["sourceCommit"] = self.requirements["sourceCommit"] = component.C07_SOURCE
        draft = self.requirements["providerFamilies"][0]
        draft["untrackedPotentialRequests"] = [{"requirementId": "chitchats.drafts.accepted-request-completeness", "requestKinds": ["flat-rate-probe-before-acknowledgement"]}]
        draft["annotations"] = [{"file": file, "sha256": digest} for file, digest in component.C07_PROBE_BLOBS.items()]
        self.remote.update(order_id="flat-rate-probe-ca_on-xs", to_name="Lash Her Rate Probe", to_address_1="100 Main Street", to_address_2=None, to_city="Toronto", to_province_code="ON", to_postal_code="M5V 2T6", to_country_code="CA", to_phone="4165550100", to_email="shipping-rates@lashher.com", description="Beauty merchandise")
        result = self.observe()
        self.assertEqual(result["effects"][0]["classification"], "source-matching-unreceipted-rate-probe")
        self.assertFalse(result["effects"][0]["reconciled"])
        self.assertIsNone(result["uncertainEffects"])

    def test_missing_family_source_binding_overflow_columns_and_unknown_rows_refuse(self):
        self.requirements["providerFamilies"].pop()
        with self.assertRaisesRegex(ValueError, "FAMILY_COVERAGE"):
            self.observe()
        self.actual_rows["shipments"][0]["private_extra"] = "private"
        with self.assertRaisesRegex(ValueError, "COLUMN_OR_LIMIT"):
            component.normalize_snapshot(self.actual_rows)
        self.actual_rows["shipments"].pop()
        self.actual_rows["jobs"] = [deepcopy(self.actual_rows["jobs"][0])] * 4097
        with self.assertRaisesRegex(ValueError, "COLUMN_OR_LIMIT"):
            component.normalize_snapshot(self.actual_rows)

    def test_provider_duplicate_missing_count_detail_drift_and_unknown_inventory_refuse(self):
        for flag in ("duplicate", "changed_order", "drift"):
            setattr(self, flag, True)
            with self.assertRaises(ValueError):
                self.observe()
            setattr(self, flag, False)
            self.reads = 0
        self.count_delta = 1
        with self.assertRaisesRegex(ValueError, "INVENTORY_MISMATCH"):
            self.observe()

    def test_source_and_private_normalization_do_not_mutate_original_rows(self):
        original = deepcopy(self.actual_rows)
        self.observe()
        self.assertEqual(self.actual_rows, original)
        self.requirements["sourceInventorySha256"] = "3" * 64
        with self.assertRaisesRegex(ValueError, "VERIFIED_SOURCE"):
            self.observe()

    def test_transport_seam_denies_mutations_other_clients_unreviewed_ids_and_query_filters(self):
        prefix = "/api/v1/clients/ownedClient/shipments"
        self.assertTrue(component.read_only_request("GET", prefix + "/ownedShipment", None, self.shipping))
        for method, path, body in (("DELETE", prefix + "/ownedShipment", None), ("GET", prefix + "/unreviewed", None), ("GET", prefix + "?limit=100&page=1&q=probe", None), ("GET", prefix + "/count", {}), ("GET", "/api/v1/clients/other/shipments/count", None)):
            self.assertFalse(component.read_only_request(method, path, body, self.shipping))


    def test_source_owned_exact_original_capability_closure_can_close_only_its_family_gap(self):
        self.requirements["sqlCredentialRequirements"] = [{"requirementId": "sql-credentials.DATABASE_URL"}]
        draft = self.requirements["providerFamilies"][0]
        draft["untrackedPotentialRequests"] = [{"requirementId": "chitchats.drafts.accepted-request-completeness"}]
        required = sorted(["sql-credentials.DATABASE_URL", "chitchats.drafts.original-configuration", "chitchats.drafts.durable-intents", "chitchats.drafts.accepted-request-completeness"])
        self.requirements["capabilityClosures"] = [{"familyId": "chitchats.drafts", "disposition": "no-capability-observed", "requirementIds": required, "evidenceIds": ["a" * 64], **{key: self.requirements[key] for key in ("sourceCommit", "surfaceSha256", "configurationRecordSha256", "provenanceSha256")}}]
        result = self.observe()
        self.assertGreater(result["knownUncertainEffects"], -1)
        self.assertIn("chitchats.drafts.accepted-request-completeness", result["missingRequirementIds"])
        self.assertIsNone(result["uncertainEffects"])
        self.requirements["capabilityClosures"][0]["requirementIds"].remove("sql-credentials.DATABASE_URL")
        with self.assertRaisesRegex(ValueError, "CLOSURE_COVERAGE"):
            self.observe()

    def test_source_absence_still_requires_original_configuration_and_sql_credential_closure(self):
        family = self.requirements["providerFamilies"][0]
        family.update(sourceDisposition="absent-from-verified-source", configurationConditions=[], sqlIntentRequirements=[], untrackedPotentialRequests=[])
        self.assertIsNone(self.observe()["uncertainEffects"])
        self.requirements["capabilityClosures"] = [{"familyId": "chitchats.drafts", "disposition": "absent-from-verified-source", "requirementIds": [], "evidenceIds": ["a" * 64], **{key: self.requirements[key] for key in ("sourceCommit", "surfaceSha256", "configurationRecordSha256", "provenanceSha256")}}]
        self.assertIsNone(self.observe()["uncertainEffects"])

    def closed_source(self):
        self.requirements["sqlCredentialRequirements"] = [{"requirementId": "sql-credentials.DATABASE_URL"}]
        self.requirements["capabilityClosures"] = [{"familyId": family["familyId"], "disposition": "no-capability-observed",
            **{key: self.requirements[key] for key in ("sourceCommit", "surfaceSha256", "configurationRecordSha256", "provenanceSha256")},
            "requirementIds": sorted({item["requirementId"] for key in ("configurationConditions", "sqlIntentRequirements", "untrackedPotentialRequests") for item in family[key]} | {"sql-credentials.DATABASE_URL"}),
            "evidenceIds": ["a" * 64]} for family in self.requirements["providerFamilies"]]

    def test_all_source_closures_and_original_current_empty_sql_need_no_client_or_fabricated_principal(self):
        self.closed_source()
        rows = {name: [] for name in component.COLUMNS}
        reviewed = {key: self.shipping[key] for key in ("environment", "sourceCommit", "sourceInventorySha256", "requirementsSha256")}
        result = component.observe_scoped_effects(None, reviewed, rows, self.requirements, before=rows)
        self.assertEqual((result["activeExecutions"], result["uncertainEffects"]), (0, 0))
        self.assertIsNone(result["clientId"]); self.assertFalse(result["providerRequestsRequired"])
        self.assertIn("sql-credentials.DATABASE_URL", result["coveredRequirementIds"])
        self.assertEqual(len(component.database_queries(reviewed)), 4)
        with self.assertRaises(ValueError):
            component.observe_scoped_effects(None, reviewed, rows, self.requirements)
        with self.assertRaises(ValueError):
            component.observe_scoped_effects(None, reviewed, self.actual_rows, self.requirements, before=rows)
        self.requirements["capabilityClosures"].pop()
        with self.assertRaises(ValueError):
            component.observe_scoped_effects(None, reviewed, rows, self.requirements, before=rows)

    def test_closure_context_transplant_and_missing_global_requirement_refuse(self):
        self.closed_source(); original = deepcopy(self.requirements)
        rows = {name: [] for name in component.COLUMNS}
        for key in ("sourceCommit", "surfaceSha256", "configurationRecordSha256", "provenanceSha256"):
            self.requirements = deepcopy(original)
            self.requirements["capabilityClosures"][0][key] = "9" * (40 if key == "sourceCommit" else 64)
            with self.assertRaisesRegex(ValueError, "CLOSURE_CONTEXT"):
                component.observe_scoped_effects(None, self.shipping, rows, self.requirements, before=rows)
        self.requirements = deepcopy(original)
        self.requirements["capabilityClosures"][0]["requirementIds"].remove("sql-credentials.DATABASE_URL")
        with self.assertRaisesRegex(ValueError, "CLOSURE_COVERAGE"):
            component.observe_scoped_effects(None, self.shipping, rows, self.requirements, before=rows)

    def test_actual_c07_source_pipeline_matches_no_client_empty_scope(self):
        root = Path(__file__).resolve().parents[3]
        program = r"""
import {verifiedSourceRequirements,historicalSourceSha256 as sha,prepareHistoricalSourceOriginalConfiguration as prepare,observeHistoricalSourceSqlCredentials as observe,deriveHistoricalSourceCapabilityClosures as derive} from './ops/platform/frontend-historical-source.mjs';
const source=verifiedSourceRequirements(process.cwd(),'b99d4f346696f897fa6a6729dfcc52d6503fe8d6');
const surfaceSha256=sha({fixture:'owned-chitchats-empty'}),configurationRecordSha256=sha({fixture:'owned-chitchats-original'}),keyCatalog=[];
const provenance={surfaceSha256,sourceCommit:source.sourceCommit,configurationRecordSha256,kind:'deployment',immutableReference:'owned:chitchats-original',entrypoint:null,keyCatalogSha256:sha(keyCatalog)};
const binding={surfaceSha256,sourceCommit:source.sourceCommit,configurationRecordSha256,sourceConfiguration:{...provenance,provenanceSha256:sha(provenance),databaseRoles:[]}};
const original={sourceCommit:source.sourceCommit,configurationRecordSha256,provenance,keyCatalog,environment:{}};
prepare(source,binding,original);const sql=await observe(source,{binding,originalConfiguration:original,clientsByKey:new Map(),physicalDatabasesByKey:new Map(),verifySession:async()=>{}});
console.log(JSON.stringify({...source,...derive(source,binding,original,sql)}));
"""
        source = json.loads(subprocess.run([os.environ.get("NODE_BINARY", "/Users/dardan/.nvm/versions/node/v24.18.0/bin/node"), "--input-type=module", "-e", program],
            cwd=root, check=True, capture_output=True, text=True).stdout)
        reviewed = {"environment": "staging", **{key: source[key] for key in ("sourceCommit", "sourceInventorySha256", "requirementsSha256")}}
        rows = {name: [] for name in component.COLUMNS}
        result = component.observe_scoped_effects(None, reviewed, rows, source, before=rows)
        self.assertEqual((result["activeExecutions"], result["uncertainEffects"]), (0, 0))
        self.assertEqual(len([item for item in result["coveredRequirementIds"] if item.startswith("sql-credentials.")]), 4)

    def test_cross_border_customs_mismatch_is_not_a_draft_receipt(self):
        row = self.actual_rows["shipments"][0]
        row["destination"]["countryCode"] = "US"
        self.remote["to_country_code"] = "US"
        self.remote["line_items"] = [{"description": "Private Product", "quantity": 1, "value_amount": "60.00", "currency_code": "cad"}]
        row["raw_shipment"] = deepcopy(self.remote)
        self.assertGreater(self.observe()["uncertainEffects"], 0)
        row["customs_lines"][0]["unitWeightGrams"] = 250
        self.remote["line_items"][0].update(weight_unit="g", weight=250)
        self.assertEqual(self.observe()["uncertainEffects"], 0)
        self.remote["line_items"][0]["value_amount"] = "60.01"
        self.assertGreater(self.observe()["uncertainEffects"], 0)


    def test_exact_operation_payload_hash_matches_javascript_source_algorithm(self):
        payload = {"expectedShipmentStateVersion": 2, "signatureRequested": False, "merchandiseValueCents": 6000,
            "address": {"name": "Private Référence", "ab": 1, "aX": 2}}
        javascript = "const crypto=require('node:crypto');let s='';process.stdin.on('data',v=>s+=v).on('end',()=>{const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>JSON.stringify(k)+':'+canonical(x)).join(',')+'}':JSON.stringify(v);process.stdout.write(crypto.createHash('sha256').update(canonical(JSON.parse(s))).digest('hex'));});"
        actual = subprocess.run([os.environ.get("NODE_BIN", "/Users/dardan/.nvm/versions/node/v24.18.0/bin/node"), "-e", javascript], input=json.dumps(payload), text=True, capture_output=True, check=True)
        self.assertEqual(actual.stdout, component._operation_hash(payload))

    def test_json_payload_unicode_uses_source_utf8_and_unsafe_number_refuses(self):
        payload = {"expectedShipmentStateVersion": 1, "reason": "réconciliation"}
        self.assertEqual(component._operation_hash(payload), hashlib.sha256('{"expectedShipmentStateVersion":1,"reason":"réconciliation"}'.encode()).hexdigest())
        self.assertIsNone(component._operation_hash({"value": 9007199254740992}))


@unittest.skipUnless(os.environ.get("CRM_SHIPPING_OWNED_POSTGRES_TEST") == "true", "explicit owned PostgreSQL fixture only")
class DatabaseTransientTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixture.DatabaseRetirementTests.setUpClass.__func__(cls)

    sql = classmethod(fixture.DatabaseRetirementTests.sql.__func__)
    cleanup_cluster = classmethod(fixture.DatabaseRetirementTests.cleanup_cluster.__func__)
    setUp = TransientTests.setUp
    tearDown = TransientTests.tearDown
    clients = fixture.RetirementTests.clients
    observe = TransientTests.observe

    def actual(self):
        selected = ["'" + name + "',(SELECT coalesce(json_agg(row_to_json(r)),'[]'::json) FROM (" + sql + ") r)" for name, sql, params in component.database_queries(self.shipping) if not params]
        raw = self.sql("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT json_build_object(" + ",".join(selected) + "); COMMIT;")
        return json.loads(next(line for line in raw.splitlines() if line.startswith("{")))

    def test_actual_migrated_sql_draft_cache_lease_payload_and_pre_ack_orphan(self):
        self.assertEqual(self.migration_count, 83)
        self.sql("TRUNCATE product_shipment_events, product_shipment_jobs, product_shipments, shipping_rate_cache CASCADE;")
        shipment, job = self.actual_rows["shipments"][0], self.actual_rows["jobs"][0]
        # Private synthetic payloads remain only in fixture memory/child stdin.
        def literal(value):
            return "'" + json.dumps(value).replace("'", "''") + "'::jsonb"
        self.sql("INSERT INTO product_shipments(id,public_reference,quote_token_hash,quote_fingerprint,status,destination,package_snapshot,customs_lines,rates,quote_expires_at,provider_shipment_id,provider_status,raw_shipment) VALUES ('" + shipment["id"] + "','owned-public-reference','owned-token-hash','private-fingerprint','quoted'," + literal(shipment["destination"]) + "," + literal(shipment["package_snapshot"]) + "," + literal(shipment["customs_lines"]) + "," + literal(shipment["rates"]) + ",now()+interval '1 hour','ownedShipment','pending'," + literal(self.remote) + ");")
        self.sql("INSERT INTO product_shipment_jobs(id,shipment_id,type,status,idempotency_key,attempt_count,operation_payload_hash,payload,outcome_unknown,outcome_code,completed_at) VALUES ('" + job["id"] + "','" + shipment["id"] + "','create','succeeded','owned-create-intent',1,'" + job["operation_payload_hash"] + "'," + literal(job["payload"]) + ",false,'created',now()); INSERT INTO shipping_rate_cache(zone_id,size_bucket_id,country_code,postage_type,title,amount_cents) VALUES ('ca_on','xs','CA','canada_post_tracked','private-cache-title',100);")
        self.actual_rows = self.actual()
        result = self.observe()
        self.assertEqual((result["activeExecutions"], result["uncertainEffects"]), (0, 0))
        self.assertFalse(result["rateCacheReceipts"][0]["isRequestCompletionReceipt"])
        self.sql("UPDATE product_shipment_jobs SET lease_expires_at=now()+interval '1 hour';")
        self.actual_rows = self.actual()
        result = self.observe()
        self.assertEqual(result["activeExecutions"], 1)
        self.assertGreater(result["uncertainEffects"], 0)
        self.sql("UPDATE product_shipment_jobs SET lease_expires_at=null,payload=jsonb_set(payload,'{merchandiseValueCents}','5000');")
        self.actual_rows = self.actual()
        self.assertGreater(self.observe()["uncertainEffects"], 0)
        self.sql("UPDATE product_shipment_jobs SET payload=jsonb_set(payload,'{merchandiseValueCents}','6000'); UPDATE product_shipments SET provider_shipment_id=null;")
        self.actual_rows = self.actual()
        self.assertGreater(self.observe()["uncertainEffects"], 0)


if __name__ == "__main__":
    unittest.main()
