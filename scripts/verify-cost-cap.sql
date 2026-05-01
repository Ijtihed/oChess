-- Verify the new ai_settings + record_ai_spend_or_block flow.
--
-- Run this against your production DB in the Supabase SQL editor.
-- The whole thing runs in a transaction with ROLLBACK at the
-- end so NO production spend is logged. Output is the test
-- assertion results.
--
-- Pass criteria: every "OK" line should print "PASS".

begin;

-- Snapshot the current real settings + month-to-date spend
-- so the assertions below are framed against realistic state.
do $$
declare
  v_cap bigint;
  v_soft bigint;
  v_used bigint;
begin
  select monthly_cap_micro_usd, soft_warning_micro_usd
    into v_cap, v_soft
    from ai_settings
   where id = 1;
  select coalesce(sum(micro_usd), 0)
    into v_used
    from ai_spend_log
   where created_at >= date_trunc('month', now() at time zone 'UTC');
  raise notice 'CURRENT SETTINGS: cap=% soft=% month-to-date=%',
    v_cap, v_soft, v_used;
end $$;

-- Set a tiny test cap (€10 hard / €8 soft) so we don't have to
-- insert €100 worth of fake spend rows to test the boundary.
update ai_settings
  set monthly_cap_micro_usd = 10000000,
      soft_warning_micro_usd = 8000000
  where id = 1;

-- The function reads ai_spend_log, so we backdate or not
-- depending on what we want to simulate. To simulate "currently
-- at €5", insert €5 of fake spend in the current month.
delete from ai_spend_log where feature = 'cost_cap_test';
insert into ai_spend_log(feature, provider, model, input_tokens, output_tokens, micro_usd)
  values ('cost_cap_test', 'test', 'test-model', 0, 0, 5000000);

-- Test 1: a small new charge should be ALLOWED, no warning
-- (we're at €5, this adds €1, still under both thresholds).
do $$
declare r record;
begin
  select * into r from record_ai_spend_or_block(
    'cost_cap_test', 'test', 'test-model', 0, 0, 1000000, 0
  );
  if r.allowed = true and r.warning_active = false then
    raise notice 'TEST 1 (under soft): PASS (used=% cap=% warning=%)',
      r.used_micro_usd, r.cap_micro_usd, r.warning_active;
  else
    raise notice 'TEST 1 (under soft): FAIL (allowed=% warning=% used=%)',
      r.allowed, r.warning_active, r.used_micro_usd;
  end if;
end $$;

-- Test 2: a charge that crosses the soft threshold should be
-- ALLOWED but warning_active=true.
-- We're now at €6. Adding €3 puts us at €9 which is >= €8 soft.
do $$
declare r record;
begin
  select * into r from record_ai_spend_or_block(
    'cost_cap_test', 'test', 'test-model', 0, 0, 3000000, 0
  );
  if r.allowed = true and r.warning_active = true then
    raise notice 'TEST 2 (cross soft): PASS (used=% warning=%)',
      r.used_micro_usd, r.warning_active;
  else
    raise notice 'TEST 2 (cross soft): FAIL (allowed=% warning=% used=%)',
      r.allowed, r.warning_active, r.used_micro_usd;
  end if;
end $$;

-- Test 3: a charge that would cross the hard cap should be
-- BLOCKED. We're at €9 of €10 cap. Adding €5 would push us to
-- €14, well over. Expected: allowed=false, warning_active=true.
do $$
declare r record;
begin
  select * into r from record_ai_spend_or_block(
    'cost_cap_test', 'test', 'test-model', 0, 0, 5000000, 0
  );
  if r.allowed = false then
    raise notice 'TEST 3 (over hard): PASS (allowed=false used=% remaining=%)',
      r.used_micro_usd, r.remaining_micro_usd;
  else
    raise notice 'TEST 3 (over hard): FAIL (allowed=true used=%)',
      r.used_micro_usd;
  end if;
end $$;

-- Test 4: when the legacy p_monthly_cap_micro_usd parameter is
-- passed (any value), it should be IGNORED. The function still
-- uses ai_settings. We pass 999_999_999_999 (an astronomically
-- huge "cap"); if the function used it, the call would be
-- allowed despite being above the real €10 cap.
do $$
declare r record;
begin
  select * into r from record_ai_spend_or_block(
    'cost_cap_test', 'test', 'test-model', 0, 0, 5000000, 999999999999
  );
  if r.allowed = false and r.cap_micro_usd = 10000000 then
    raise notice 'TEST 4 (legacy param ignored): PASS (cap=% honoured)',
      r.cap_micro_usd;
  else
    raise notice 'TEST 4 (legacy param ignored): FAIL (allowed=% cap=%)',
      r.allowed, r.cap_micro_usd;
  end if;
end $$;

-- Test 5: with the settings row temporarily deleted, the
-- function should fall back to the conservative 100 USD cap
-- defined in the function body. Insert a fresh charge of €1
-- (well under €100) and confirm it's allowed AND cap=100M.
delete from ai_settings where id = 1;
do $$
declare r record;
begin
  select * into r from record_ai_spend_or_block(
    'cost_cap_test', 'test', 'test-model', 0, 0, 1000000, 0
  );
  if r.allowed = true and r.cap_micro_usd = 100000000 then
    raise notice 'TEST 5 (settings missing fallback): PASS (cap=% allowed=true)',
      r.cap_micro_usd;
  else
    raise notice 'TEST 5 (settings missing fallback): FAIL (allowed=% cap=%)',
      r.allowed, r.cap_micro_usd;
  end if;
end $$;

-- Cleanup is automatic via ROLLBACK.
rollback;

-- After rollback the real ai_settings row + ai_spend_log are
-- untouched. Verify by re-reading.
select 'AFTER ROLLBACK: ' as label,
       monthly_cap_micro_usd, soft_warning_micro_usd
  from ai_settings;
