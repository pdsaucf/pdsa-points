-- ===========================================================================
-- 12. EVIDENCE BUCKET AND ITS POLICIES
-- ===========================================================================
-- A private bucket. Uploads go straight from the browser to Storage, so the
-- hot path at an event (sixty people scanning in ninety seconds on venue
-- wifi) is one PUT to a CDN-backed object store rather than a cold-starting
-- function.
--
-- What keeps that safe is the grant table from migration 08: an anonymous
-- caller may write exactly one object path, once, within thirty minutes, and
-- only after create_evidence_upload() agreed that the event asks for that
-- kind of photo.
--
-- Note on applying this to Supabase: storage.objects belongs to
-- supabase_storage_admin and already has RLS enabled, so this file only
-- creates policies on it and never runs ALTER TABLE against it.
-- ===========================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'evidence',
  'evidence',
  false,
  8388608,                                        -- 8 MB, matching the client-side reject
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic']
)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Anonymous upload, against a live grant and nothing else
-- ---------------------------------------------------------------------------

drop policy if exists evidence_insert_granted on storage.objects;
create policy evidence_insert_granted on storage.objects
  for insert to anon, authenticated
  with check (
    bucket_id = 'evidence'
    and public.fn_upload_grant_is_live('evidence', storage.objects.name)
  );

-- ---------------------------------------------------------------------------
-- Reading
-- ---------------------------------------------------------------------------

drop policy if exists evidence_read_staff on storage.objects;
create policy evidence_read_staff on storage.objects
  for select to authenticated
  using (bucket_id = 'evidence' and public.fn_is_staff());

drop policy if exists evidence_read_own on storage.objects;
create policy evidence_read_own on storage.objects
  for select to authenticated
  using (
    bucket_id = 'evidence'
    and exists (
      select 1
      from public.attendance_evidence ae
      join public.attendance_records ar on ar.id = ae.attendance_record_id
      where ae.object_path = storage.objects.name
        and ar.member_id = public.fn_current_member_id()
    )
  );

-- ---------------------------------------------------------------------------
-- Deleting
-- ---------------------------------------------------------------------------
-- Only officers, and only ever as the result of somebody pressing the purge
-- button. Nothing in this schema deletes a photo on a timer.
-- ---------------------------------------------------------------------------

drop policy if exists evidence_delete_officer on storage.objects;
create policy evidence_delete_officer on storage.objects
  for delete to authenticated
  using (bucket_id = 'evidence' and public.fn_is_officer());
