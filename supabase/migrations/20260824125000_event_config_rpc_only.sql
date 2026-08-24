-- Event fields, category links and evidence are one configuration and may
-- only be mutated through save_event_config(). Legacy table grants let an old
-- or hand-written authenticated client bypass its transaction, revision check
-- and lock ordering. Keep reads, and keep only the direct event DELETE used by
-- the officer UI. Child rows leave through the event foreign-key cascades.

revoke insert, update on table events from authenticated;
revoke insert, update, delete on table event_categories from authenticated;
revoke insert, update, delete on table event_evidence_requirements from authenticated;

drop policy if exists events_write on events;
drop policy if exists event_categories_write on event_categories;
drop policy if exists event_evidence_write on event_evidence_requirements;

create policy events_delete on events
for delete to authenticated
using (fn_is_shared_admin());

comment on policy events_delete on events is
  'The officer event-detail screen may delete an event with no attendance. All event configuration writes use save_event_config().';
