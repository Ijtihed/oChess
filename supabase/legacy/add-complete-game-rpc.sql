-- ══════════════════════════════════════════════════════════════
-- Server-side game completion + Glicko-2 rating update
-- Run in the Supabase SQL Editor
-- ══════════════════════════════════════════════════════════════

-- Glicko-2 helper: runs the full algorithm server-side so clients
-- can't manipulate ratings.

create or replace function glicko2_update(
  p_game_id uuid,
  p_result text,        -- '1-0', '0-1', '1/2-1/2', '*'
  p_result_reason text,
  p_pgn text,
  p_moves_count int
)
returns jsonb as $$
declare
  v_game record;
  v_cat text;
  v_w_row record;
  v_b_row record;
  v_w_score float;
  v_b_score float;
  -- Glicko-2 constants
  c_tau float := 0.5;
  c_epsilon float := 0.000001;
  c_scale float := 173.7178;
  -- Player Glicko-2 vars
  v_mu float; v_phi float; v_sigma float;
  v_opp_mu float; v_opp_phi float;
  v_g float; v_e float; v_v float; v_delta float;
  v_a float; v_b float; v_fa float; v_fb float; v_fc float; v_c float;
  v_k int;
  v_new_sigma float; v_phi_star float; v_new_phi float; v_new_mu float;
  v_new_rating float; v_new_rd float;
  v_change float;
  v_field text;
  v_outcome text;
begin
  -- Lock the game row
  select * into v_game from games where id = p_game_id for update;
  if v_game is null then
    return jsonb_build_object('error', 'Game not found');
  end if;
  if v_game.status = 'completed' then
    return jsonb_build_object('ok', true, 'already_completed', true);
  end if;

  -- Mark game completed
  update games set
    pgn = p_pgn,
    result = p_result,
    result_reason = p_result_reason,
    moves_count = p_moves_count,
    status = 'completed',
    ended_at = now()
  where id = p_game_id;

  -- If aborted or unrated, skip rating math
  if p_result = '*' or not coalesce(v_game.is_rated, false) then
    return jsonb_build_object('ok', true);
  end if;

  -- Determine category
  v_cat := coalesce(v_game.category, 'blitz');

  -- Scores
  if p_result = '1-0' then
    v_w_score := 1.0; v_b_score := 0.0;
  elsif p_result = '0-1' then
    v_w_score := 0.0; v_b_score := 1.0;
  else
    v_w_score := 0.5; v_b_score := 0.5;
  end if;

  -- Fetch white rating row
  select * into v_w_row from ratings
    where user_id = v_game.white_id and category = v_cat;
  -- Fetch black rating row
  select * into v_b_row from ratings
    where user_id = v_game.black_id and category = v_cat;

  if v_w_row is null or v_b_row is null then
    return jsonb_build_object('ok', true, 'ratings_skipped', true);
  end if;

  -- ── Update WHITE rating ──
  v_mu := (v_w_row.rating - 1500) / c_scale;
  v_phi := v_w_row.rd / c_scale;
  v_sigma := v_w_row.volatility;
  v_opp_mu := (v_b_row.rating - 1500) / c_scale;
  v_opp_phi := v_b_row.rd / c_scale;

  v_g := 1.0 / sqrt(1.0 + 3.0 * v_opp_phi * v_opp_phi / (pi() * pi()));
  v_e := 1.0 / (1.0 + exp(-v_g * (v_mu - v_opp_mu)));
  v_v := 1.0 / (v_g * v_g * v_e * (1.0 - v_e));
  v_delta := v_v * v_g * (v_w_score - v_e);

  v_a := ln(v_sigma * v_sigma);
  if v_delta * v_delta > v_phi * v_phi + v_v then
    v_b := ln(v_delta * v_delta - v_phi * v_phi - v_v);
  else
    v_k := 1;
    loop
      exit when (
        (exp(v_a - v_k * c_tau) * (v_delta * v_delta - v_phi * v_phi - v_v - exp(v_a - v_k * c_tau)))
        / (2.0 * (v_phi * v_phi + v_v + exp(v_a - v_k * c_tau)) * (v_phi * v_phi + v_v + exp(v_a - v_k * c_tau)))
        - (v_a - v_k * c_tau - v_a) / (c_tau * c_tau)
      ) >= 0 or v_k > 100;
      v_k := v_k + 1;
    end loop;
    v_b := v_a - v_k * c_tau;
  end if;

  v_fa := (exp(v_a) * (v_delta*v_delta - v_phi*v_phi - v_v - exp(v_a))) / (2.0*(v_phi*v_phi + v_v + exp(v_a))*(v_phi*v_phi + v_v + exp(v_a))) - (v_a - v_a)/(c_tau*c_tau);
  v_fb := (exp(v_b) * (v_delta*v_delta - v_phi*v_phi - v_v - exp(v_b))) / (2.0*(v_phi*v_phi + v_v + exp(v_b))*(v_phi*v_phi + v_v + exp(v_b))) - (v_b - v_a)/(c_tau*c_tau);
  for i in 1..100 loop
    exit when abs(v_b - v_a) < c_epsilon;
    v_c := v_a + (v_a - v_b) * v_fa / (v_fb - v_fa);
    v_fc := (exp(v_c) * (v_delta*v_delta - v_phi*v_phi - v_v - exp(v_c))) / (2.0*(v_phi*v_phi + v_v + exp(v_c))*(v_phi*v_phi + v_v + exp(v_c))) - (v_c - v_a)/(c_tau*c_tau);
    if v_fc * v_fb <= 0 then v_a := v_b; v_fa := v_fb;
    else v_fa := v_fa / 2.0; end if;
    v_b := v_c; v_fb := v_fc;
  end loop;

  v_new_sigma := exp(v_b / 2.0);
  v_phi_star := sqrt(v_phi * v_phi + v_new_sigma * v_new_sigma);
  v_new_phi := 1.0 / sqrt(1.0 / (v_phi_star * v_phi_star) + 1.0 / v_v);
  v_new_mu := v_mu + v_new_phi * v_new_phi * v_g * (v_w_score - v_e);
  v_new_rating := round((v_new_mu * c_scale + 1500)::numeric, 1);
  v_new_rd := round((v_new_phi * c_scale)::numeric, 1);
  v_change := round((v_new_rating - v_w_row.rating)::numeric, 1);

  v_outcome := case when v_w_score = 1.0 then 'wins' when v_w_score = 0.0 then 'losses' else 'draws' end;
  execute format(
    'update ratings set rating = $1, rd = $2, volatility = $3, games_played = games_played + 1, %I = %I + 1, updated_at = now() where id = $4',
    v_outcome, v_outcome
  ) using v_new_rating, v_new_rd, round(v_new_sigma::numeric, 6), v_w_row.id;

  update games set white_rating_change = v_change where id = p_game_id;

  -- ── Update BLACK rating (same algorithm) ──
  v_mu := (v_b_row.rating - 1500) / c_scale;
  v_phi := v_b_row.rd / c_scale;
  v_sigma := v_b_row.volatility;
  v_opp_mu := (v_w_row.rating - 1500) / c_scale;
  v_opp_phi := v_w_row.rd / c_scale;

  v_g := 1.0 / sqrt(1.0 + 3.0 * v_opp_phi * v_opp_phi / (pi() * pi()));
  v_e := 1.0 / (1.0 + exp(-v_g * (v_mu - v_opp_mu)));
  v_v := 1.0 / (v_g * v_g * v_e * (1.0 - v_e));
  v_delta := v_v * v_g * (v_b_score - v_e);

  v_a := ln(v_sigma * v_sigma);
  if v_delta * v_delta > v_phi * v_phi + v_v then
    v_b := ln(v_delta * v_delta - v_phi * v_phi - v_v);
  else
    v_k := 1;
    loop
      exit when (
        (exp(v_a - v_k * c_tau) * (v_delta * v_delta - v_phi * v_phi - v_v - exp(v_a - v_k * c_tau)))
        / (2.0 * (v_phi * v_phi + v_v + exp(v_a - v_k * c_tau)) * (v_phi * v_phi + v_v + exp(v_a - v_k * c_tau)))
        - (v_a - v_k * c_tau - v_a) / (c_tau * c_tau)
      ) >= 0 or v_k > 100;
      v_k := v_k + 1;
    end loop;
    v_b := v_a - v_k * c_tau;
  end if;

  v_fa := (exp(v_a) * (v_delta*v_delta - v_phi*v_phi - v_v - exp(v_a))) / (2.0*(v_phi*v_phi + v_v + exp(v_a))*(v_phi*v_phi + v_v + exp(v_a))) - (v_a - v_a)/(c_tau*c_tau);
  v_fb := (exp(v_b) * (v_delta*v_delta - v_phi*v_phi - v_v - exp(v_b))) / (2.0*(v_phi*v_phi + v_v + exp(v_b))*(v_phi*v_phi + v_v + exp(v_b))) - (v_b - v_a)/(c_tau*c_tau);
  for i in 1..100 loop
    exit when abs(v_b - v_a) < c_epsilon;
    v_c := v_a + (v_a - v_b) * v_fa / (v_fb - v_fa);
    v_fc := (exp(v_c) * (v_delta*v_delta - v_phi*v_phi - v_v - exp(v_c))) / (2.0*(v_phi*v_phi + v_v + exp(v_c))*(v_phi*v_phi + v_v + exp(v_c))) - (v_c - v_a)/(c_tau*c_tau);
    if v_fc * v_fb <= 0 then v_a := v_b; v_fa := v_fb;
    else v_fa := v_fa / 2.0; end if;
    v_b := v_c; v_fb := v_fc;
  end loop;

  v_new_sigma := exp(v_b / 2.0);
  v_phi_star := sqrt(v_phi * v_phi + v_new_sigma * v_new_sigma);
  v_new_phi := 1.0 / sqrt(1.0 / (v_phi_star * v_phi_star) + 1.0 / v_v);
  v_new_mu := v_mu + v_new_phi * v_new_phi * v_g * (v_b_score - v_e);
  v_new_rating := round((v_new_mu * c_scale + 1500)::numeric, 1);
  v_new_rd := round((v_new_phi * c_scale)::numeric, 1);
  v_change := round((v_new_rating - v_b_row.rating)::numeric, 1);

  v_outcome := case when v_b_score = 1.0 then 'wins' when v_b_score = 0.0 then 'losses' else 'draws' end;
  execute format(
    'update ratings set rating = $1, rd = $2, volatility = $3, games_played = games_played + 1, %I = %I + 1, updated_at = now() where id = $4',
    v_outcome, v_outcome
  ) using v_new_rating, v_new_rd, round(v_new_sigma::numeric, 6), v_b_row.id;

  update games set black_rating_change = v_change where id = p_game_id;

  return jsonb_build_object('ok', true);
end;
$$ language plpgsql security definer;

grant execute on function glicko2_update(uuid, text, text, text, int) to authenticated;
