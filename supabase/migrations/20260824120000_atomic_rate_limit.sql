-- A limiter decision and its increment have to be one row-locking statement.
-- The original function selected call_count first, then incremented it with an
-- upsert. Concurrent transactions could all observe max - 1 before any of
-- them updated the row, then all be admitted and push the counter past max.
--
-- PostgreSQL rechecks an ON CONFLICT DO UPDATE WHERE predicate after locking
-- the conflicting row. That makes the ceiling atomic across connections: one
-- transaction can take the final slot and every waiter then returns no row.

create or replace function fn_rate_limit_check(p_key text, p_max_per_minute int)
returns void
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_window timestamptz := date_trunc('minute', now());
  v_count  int;
begin
  if p_max_per_minute < 1 then
    raise exception 'The request limit is not configured correctly.'
      using errcode = 'PDS09';
  end if;

  insert into rpc_call_counters (bucket_key, window_start, call_count)
  values (p_key, v_window, 1)
  on conflict (bucket_key, window_start) do update
    set call_count = rpc_call_counters.call_count + 1
    where rpc_call_counters.call_count < p_max_per_minute
  returning call_count into v_count;

  if v_count is null then
    raise exception 'Too many requests. Please wait a moment and try again.'
      using errcode = 'PDS09';
  end if;

  -- Opportunistic cleanup, cheap because the table only holds recent windows.
  if v_count = 1 then
    delete from rpc_call_counters
    where window_start < v_window - interval '10 minutes';
  end if;
end
$$;

comment on function fn_rate_limit_check(text, int) is
  'Atomically admits and counts at most the configured calls per minute for one bucket. Refused calls are not counted.';
