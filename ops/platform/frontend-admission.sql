-- Bootstrap artifact only. No application startup or release entrypoint installs
-- this schema. Live adoption requires historical-writer retirement and review.
-- Execute once in a transaction as the selected admission owner, never runtime.
CREATE SCHEMA frontend_admission;
REVOKE ALL ON SCHEMA frontend_admission FROM PUBLIC;

CREATE TABLE frontend_admission.control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  environment text NOT NULL CHECK (environment IN ('staging', 'production')),
  target_sha256 text NOT NULL CHECK (target_sha256 ~ '^[a-f0-9]{64}$'),
  epoch bigint NOT NULL DEFAULT 1 CHECK (epoch > 0),
  new_work boolean NOT NULL DEFAULT false,
  recovery boolean NOT NULL DEFAULT false
);
CREATE TABLE frontend_admission.producers (
  producer_sha256 text PRIMARY KEY CHECK (producer_sha256 ~ '^[a-f0-9]{64}$'),
  source_sha text NOT NULL CHECK (source_sha ~ '^[a-f0-9]{40}$'),
  database_role oid NOT NULL,
  enabled boolean NOT NULL DEFAULT false
);
CREATE TABLE frontend_admission.operations (
  id uuid PRIMARY KEY,
  producer_sha256 text NOT NULL REFERENCES frontend_admission.producers,
  source_sha text NOT NULL CHECK (source_sha ~ '^[a-f0-9]{40}$'),
  database_role oid NOT NULL,
  epoch bigint NOT NULL CHECK (epoch > 0),
  kind text NOT NULL CHECK (kind IN ('new-work', 'recovery')),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'uncertain', 'completed')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  reconciliation_sha256 text CHECK (reconciliation_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK ((state = 'completed') = (completed_at IS NOT NULL))
);
CREATE INDEX operations_unresolved ON frontend_admission.operations (state) WHERE state <> 'completed';
REVOKE ALL ON ALL TABLES IN SCHEMA frontend_admission FROM PUBLIC;

-- Admission and closure serialize on the same row. NOWAIT refuses contention
-- rather than holding a public request behind a long release transaction.
CREATE FUNCTION frontend_admission.admit(
  operation_id uuid, operation_kind text, expected_environment text,
  expected_target text, expected_epoch bigint, producer text, source text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, frontend_admission AS $$
DECLARE policy frontend_admission.control%ROWTYPE;
        registered frontend_admission.producers%ROWTYPE;
BEGIN
  SELECT * INTO STRICT policy FROM frontend_admission.control WHERE singleton FOR UPDATE NOWAIT;
  IF policy.environment IS DISTINCT FROM expected_environment OR policy.target_sha256 IS DISTINCT FROM expected_target
      OR policy.epoch IS DISTINCT FROM expected_epoch OR operation_kind IS NULL OR operation_kind NOT IN ('new-work', 'recovery')
      OR NOT (CASE operation_kind WHEN 'new-work' THEN policy.new_work ELSE policy.recovery END) THEN
    RAISE EXCEPTION 'FRONTEND_ADMISSION_REFUSED';
  END IF;
  SELECT * INTO registered FROM frontend_admission.producers p
    WHERE p.producer_sha256 = producer AND p.source_sha = source AND p.enabled
      AND p.database_role = session_user::regrole::oid;
  IF NOT FOUND THEN RAISE EXCEPTION 'FRONTEND_ADMISSION_REFUSED'; END IF;
  INSERT INTO frontend_admission.operations (id, producer_sha256, source_sha, database_role, epoch, kind)
    VALUES (operation_id, producer, registered.source_sha, registered.database_role, policy.epoch, operation_kind);
END;
$$;

-- Closing admission or retiring a producer never prevents admitted work from
-- finishing. Uncertain operations require explicit operator reconciliation.
CREATE FUNCTION frontend_admission.settle(operation_id uuid, outcome text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, frontend_admission AS $$
BEGIN
  IF outcome IS NULL OR outcome NOT IN ('completed', 'uncertain') THEN
    RAISE EXCEPTION 'FRONTEND_OPERATION_SETTLEMENT_REFUSED';
  END IF;
  UPDATE frontend_admission.operations o SET state = outcome,
    completed_at = CASE outcome WHEN 'completed' THEN clock_timestamp() ELSE NULL END
    WHERE o.id = operation_id AND o.state = 'active'
      AND o.database_role = session_user::regrole::oid;
  IF NOT FOUND THEN RAISE EXCEPTION 'FRONTEND_OPERATION_SETTLEMENT_REFUSED'; END IF;
END;
$$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA frontend_admission FROM PUBLIC;
-- COMMIT in these invoker procedures proves durable admission/settlement before
-- returning. PostgreSQL refuses CALL inside an explicit caller transaction.
-- They must remain invoker procedures without SET clauses for transaction control.
CREATE PROCEDURE frontend_admission.begin_operation(
  operation_id uuid, operation_kind text, expected_environment text,
  expected_target text, expected_epoch bigint, producer text, source text
) LANGUAGE plpgsql AS $$
BEGIN
  PERFORM frontend_admission.admit(operation_id, operation_kind, expected_environment,
    expected_target, expected_epoch, producer, source);
  COMMIT;
END;
$$;
CREATE PROCEDURE frontend_admission.finish_operation(operation_id uuid, outcome text)
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM frontend_admission.settle(operation_id, outcome);
  COMMIT;
END;
$$;
REVOKE ALL ON ALL ROUTINES IN SCHEMA frontend_admission FROM PUBLIC;
-- The reviewed bootstrap must bind control/producer rows and grant only USAGE
-- plus EXECUTE on these routines to each selected protocol-aware login.
-- Runtime receives no table, control, producer, reconciliation or DDL grants.
