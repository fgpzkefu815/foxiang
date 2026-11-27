-- Taiwan-time draw limits: 08:00-08:30 and 12:00-12:30, 108 per session, 2 per user per Taiwan day.
create table if not exists public.draw_sessions (
  draw_date date not null,
  period text not null check (period in ('morning', 'noon')),
  draw_count integer not null default 0 check (draw_count between 0 and 108),
  primary key (draw_date, period)
);

create table if not exists public.user_draws (
  id bigint generated always as identity primary key,
  line_user_id text not null,
  draw_date date not null,
  period text not null check (period in ('morning', 'noon')),
  deity_id text not null,
  created_at timestamptz not null default now()
);

create index if not exists user_draws_user_date_idx
  on public.user_draws (line_user_id, draw_date);

create or replace function public.reserve_draw(p_line_user_id text, p_deity_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  taipei_now timestamp := timezone('Asia/Taipei', now());
  taipei_date date := (timezone('Asia/Taipei', now()))::date;
  taipei_clock time := (timezone('Asia/Taipei', now()))::time;
  v_period text;
  v_used integer;
  v_count integer;
begin
  if p_line_user_id is null or length(p_line_user_id) < 5 or p_deity_id is null then
    raise exception 'INVALID_REQUEST';
  end if;

  if taipei_clock >= time '08:00' and taipei_clock < time '08:30' then
    v_period := 'morning';
  elsif taipei_clock >= time '12:00' and taipei_clock < time '12:30' then
    v_period := 'noon';
  else
    return jsonb_build_object('ok', false, 'code', 'CLOSED',
      'next_morning', (taipei_date + time '08:00')::timestamp,
      'next_noon', (taipei_date + time '12:00')::timestamp);
  end if;

  -- Serialize this user's daily quota checks to prevent simultaneous double booking.
  perform pg_advisory_xact_lock(hashtextextended(p_line_user_id || ':' || taipei_date::text, 0));

  select count(*) into v_used
  from public.user_draws
  where line_user_id = p_line_user_id and draw_date = taipei_date;

  if v_used >= 2 then
    return jsonb_build_object('ok', false, 'code', 'DAILY_LIMIT', 'used', v_used);
  end if;

  insert into public.draw_sessions(draw_date, period)
  values (taipei_date, v_period)
  on conflict (draw_date, period) do nothing;

  select draw_count into v_count
  from public.draw_sessions
  where draw_date = taipei_date and period = v_period
  for update;

  if v_count >= 108 then
    return jsonb_build_object('ok', false, 'code', 'SESSION_FULL', 'period', v_period);
  end if;

  update public.draw_sessions
  set draw_count = draw_count + 1
  where draw_date = taipei_date and period = v_period;

  insert into public.user_draws(line_user_id, draw_date, period, deity_id)
  values (p_line_user_id, taipei_date, v_period, p_deity_id);

  return jsonb_build_object('ok', true, 'period', v_period, 'used', v_used + 1,
    'remaining', 108 - (v_count + 1));
end;
$$;

revoke all on function public.reserve_draw(text, text) from public, anon, authenticated;
grant execute on function public.reserve_draw(text, text) to service_role;
