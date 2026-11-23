CREATE TABLE frontend_admission.p407_window (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  order_id uuid NOT NULL,
  phase text NOT NULL CHECK (phase IN ('held', 'checkout', 'recovery', 'closed')),
  expires_at timestamptz,
  CHECK ((phase IN ('checkout', 'recovery')) = (expires_at IS NOT NULL))
);

CREATE FUNCTION frontend_admission.admit_p407(
  operation_id uuid, operation_kind text, expected_environment text,
  expected_target text, expected_epoch bigint, producer text, source text, order_id uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, frontend_admission AS $$
BEGIN
  -- Serialize the expiry and order check with operator transitions and admission.
  PERFORM 1 FROM frontend_admission.control WHERE singleton FOR UPDATE NOWAIT;
  IF operation_kind = 'new-work' AND EXISTS (
    SELECT 1 FROM frontend_admission.operations WHERE state = 'uncertain'
  ) THEN
    RAISE EXCEPTION 'P407_ADMISSION_REFUSED';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM frontend_admission.p407_window w
    WHERE w.singleton AND w.order_id = admit_p407.order_id
      AND w.expires_at > clock_timestamp()
      AND (w.phase = 'checkout' AND operation_kind = 'new-work' OR
           w.phase = 'recovery' AND operation_kind = 'recovery')
  ) THEN
    RAISE EXCEPTION 'P407_ADMISSION_REFUSED';
  END IF;
  PERFORM frontend_admission.admit(operation_id, operation_kind, expected_environment,
    expected_target, expected_epoch, producer, source);
END;
$$;

CREATE PROCEDURE frontend_admission.begin_p407_operation(
  operation_id uuid, operation_kind text, expected_environment text,
  expected_target text, expected_epoch bigint, producer text, source text, order_id uuid
) LANGUAGE plpgsql AS $$
BEGIN
  PERFORM frontend_admission.admit_p407(operation_id, operation_kind, expected_environment,
    expected_target, expected_epoch, producer, source, order_id);
  COMMIT;
END;
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA frontend_admission FROM PUBLIC;
REVOKE ALL ON ALL ROUTINES IN SCHEMA frontend_admission FROM PUBLIC;
