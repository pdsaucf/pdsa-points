// Photo storage and the purge flow: docs/03-admin-ui.md section 7.
//
// PURGING IS AN ACTION A PERSON TAKES, NEVER A JOB THAT RUNS ON ITS OWN
// (invariant 7). This screen exists to make that button cheap to press
// correctly: a usage bar so an officer knows there is something to do, a
// preview so nobody destroys anything blind, per-event checkboxes so one
// event's evidence can be held back for an ongoing dispute while the rest
// clears, and a history so "who cleared what, and when" has an answer.
//
// THE ONE THING SQL CANNOT DO TRANSACTIONALLY IS DELETE A STORAGE OBJECT.
// purge_evidence() marks attendance_evidence.purged_at and hands back the
// object paths; the browser then has to make a second, separate call to
// Storage to actually remove the bytes. If that second call never finishes
// (closed tab, dead wifi), the rows already read as purged and nothing will
// ever ask Storage about those paths again. purge_run_objects
// (supabase/migrations/20260815100000_storage_ops.sql) is the durable record
// of what this run intended to delete, and finish_purge_run() is how a
// partly-finished run gets closed out later. deleteAndFinish() below is the
// one place this file does both halves, so every caller (a fresh purge, an
// orphaned-upload reclaim, or finishing an old run) goes through the same
// path rather than three slightly different ones.
//
// ROLES. Officers and admins can purge; a viewer reads the usage bar and
// nothing else on this screen, because fn_purge_preview() and purge_runs
// are officer gated (the operationally sensitive detail a viewer has no
// button for anyway), while fn_storage_usage() is staff gated so the plain
// usage figure is not hidden from them. The retention window is narrower
// still: settings_write in migration 11 is fn_is_admin() while purging is
// fn_assert_officer(), so an officer can clear photos but only an admin can
// change how long they are kept. ctx.canPublish already carries exactly that
// admin-only distinction for the requirements screen; it is reused here
// rather than adding a second flag for the same rule.

import { select, patch, callRpc, deleteEvidenceObjects, evidenceObjectExists } from './rest.js';
import { formatBytes } from './format.js';
import { $, h, announce, setHidden, plural, shortDate } from './ui.js';

// A curated set of windows, the same idea as categories.js's fixed unit list:
// evidence_retention_months holds any integer, but the screen offers a short,
// sane menu rather than a free-typed number of months.
const RETENTION_MONTHS = [1, 3, 6, 9, 12, 18, 24, 36];

const ADMIN_ONLY_RETENTION = 'Only an admin can change this.';
const NEVER_ON_A_TIMER = 'Photos are never deleted automatically. Someone has to clear them.';

// deleteAndFinish()'s bookkeepingFailed case: Storage may well have deleted
// the bytes, but finish_purge_run() never confirmed it, so the run stays
// outstanding until it is retried. Same sentence everywhere it can happen
// (a fresh purge, a reclaim, or finishing an old run), since the state it
// describes is the same state in all three.
const BOOKKEEPING_INCOMPLETE = 'Bookkeeping incomplete. Will show as outstanding.';

const monthsLabel = (n) => (Number(n) === 1 ? '1 month' : `${n} months`);

/** 'March 2025', for "before <date>" in the ready-to-clear card. */
function cutoffLabel(months) {
  const date = new Date();
  date.setMonth(date.getMonth() - Number(months));
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export function createStorage(ctx) {
  const el = {
    loading: $('loading-storage'),
    body: $('storage-body'),

    usageCount: $('storage-usage-count'),
    usageBar: $('storage-usage-bar'),
    usageFill: $('storage-usage-fill'),
    usageLine: $('storage-usage-line'),
    orphaned: $('storage-orphaned'),
    orphanedText: $('storage-orphaned-text'),
    reclaim: $('storage-reclaim'),

    outstanding: $('storage-outstanding'),
    outstandingTitle: $('storage-outstanding-title'),
    finish: $('storage-finish'),

    ready: $('storage-ready'),
    readyBody: $('storage-ready-body'),
    review: $('storage-review'),
    readyNote: $('storage-ready-note'),

    retentionSelect: $('storage-retention-select'),
    retentionText: $('storage-retention-text'),
    retentionNote: $('storage-retention-note'),

    historyEmpty: $('storage-history-empty'),
    historyNote: $('storage-history-note'),
    historyTable: $('storage-history-table'),
    historyRows: $('storage-history-rows'),

    dialog: $('storage-purge-dialog'),
    dialogForm: $('storage-purge-form'),
    dialogTitle: $('storage-purge-title'),
    dialogList: $('storage-purge-list'),
    dialogConfirm: $('storage-purge-confirm'),
  };

  const state = {
    usage: null,
    retentionMonths: 12,
    preview: [], // fn_purge_preview() rows, officer only
    runs: [], // purge_runs history, officer only
    outstandingRuns: [], // v_purge_runs_outstanding, officer only
    reviewers: new Map(), // profiles.user_id -> full_name
    busy: false,
    loaded: false,
  };

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async function load() {
    setHidden(el.loading, false);
    setHidden(el.body, true);

    try {
      const [usageRows, settingRows] = await Promise.all([
        callRpc('fn_storage_usage'),
        select('app_settings', {
          select: 'value',
          filters: { key: 'eq.evidence_retention_months' },
          limit: 1,
        }),
      ]);
      state.usage = usageRows?.[0] ?? null;
      state.retentionMonths = Number(settingRows?.[0]?.value ?? 12);

      if (ctx.canReview) {
        const [preview, runs, outstanding, profiles] = await Promise.all([
          callRpc('fn_purge_preview', { p_retention_months: state.retentionMonths }),
          select('purge_runs', {
            select:
              'id,kind,performed_by,performed_at,retention_months,evidence_count,bytes_freed',
            order: 'performed_at.desc',
            limit: 25,
          }),
          select('v_purge_runs_outstanding', {
            select: 'purge_run_id,outstanding_count,total_count',
          }),
          select('profiles', { select: 'user_id,full_name' }),
        ]);
        state.preview = preview ?? [];
        state.runs = runs ?? [];
        state.outstandingRuns = outstanding ?? [];
        state.reviewers = new Map((profiles ?? []).map((row) => [row.user_id, row.full_name]));
      } else {
        state.preview = [];
        state.runs = [];
        state.outstandingRuns = [];
      }

      state.loaded = true;
      setHidden(el.loading, true);
      setHidden(el.body, false);
      render();
    } catch (err) {
      setHidden(el.loading, true);
      ctx.fail(err, load);
    }
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  function render() {
    renderUsage();
    renderReady();
    renderRetention();
    renderOutstanding();
    renderHistory();
  }

  function renderUsage() {
    const usage = state.usage;
    if (!usage) {
      el.usageCount.textContent = '';
      el.usageLine.textContent = '';
      el.usageFill.style.width = '0%';
      setHidden(el.orphaned, true);
      return;
    }

    const count = Number(usage.photo_count ?? 0);
    const bytes = Number(usage.bytes_held ?? 0);
    const quota = Number(usage.quota_bytes ?? 0);
    const percent = Number(usage.percent_used ?? 0);
    const warn = Number(usage.warn_percent ?? 75);

    el.usageCount.textContent = `${plural(count, 'photo')} · ${formatBytes(bytes)}`;
    el.usageFill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
    el.usageBar.dataset.warn = String(percent >= warn);
    el.usageLine.textContent = `${formatBytes(bytes)} of ${formatBytes(quota)}`;

    const orphaned = Number(usage.orphaned_count ?? 0);
    setHidden(el.orphaned, orphaned === 0 || !ctx.canReview);
    if (orphaned) {
      el.orphanedText.textContent = `${plural(orphaned, 'upload')} never submitted, size unknown.`;
      el.reclaim.disabled = state.busy;
    }
  }

  function renderReady() {
    if (!ctx.canReview) {
      setHidden(el.ready, true);
      setHidden(el.readyNote, false);
      return;
    }
    setHidden(el.readyNote, true);

    const rows = state.preview;
    if (!rows.length) {
      setHidden(el.ready, true);
      return;
    }

    const totalPhotos = rows.reduce((sum, row) => sum + Number(row.photo_count ?? 0), 0);
    const totalBytes = rows.reduce((sum, row) => sum + Number(row.bytes ?? 0), 0);

    setHidden(el.ready, false);
    el.readyBody.textContent =
      `${plural(totalPhotos, 'photo')} from ${plural(rows.length, 'event')} ` +
      `before ${cutoffLabel(state.retentionMonths)}. ` +
      `All of them have been reviewed. Frees about ${formatBytes(totalBytes)}.`;
    el.review.disabled = state.busy;
  }

  function renderRetention() {
    const admin = Boolean(ctx.canPublish);
    setHidden(el.retentionSelect, !admin);
    setHidden(el.retentionText, admin);

    if (admin) {
      if (!el.retentionSelect.children.length) {
        el.retentionSelect.replaceChildren(
          ...RETENTION_MONTHS.map((n) => h('option', { value: String(n) }, monthsLabel(n))),
        );
      }
      // An unusual value set some other way is still offered rather than
      // silently rounded to the nearest option in the menu.
      if (
        !RETENTION_MONTHS.includes(state.retentionMonths) &&
        !el.retentionSelect.querySelector(`option[value="${state.retentionMonths}"]`)
      ) {
        el.retentionSelect.append(
          h('option', { value: String(state.retentionMonths) }, monthsLabel(state.retentionMonths)),
        );
      }
      el.retentionSelect.value = String(state.retentionMonths);
      el.retentionSelect.disabled = state.busy;
    } else {
      el.retentionText.textContent = monthsLabel(state.retentionMonths);
    }

    el.retentionNote.textContent = admin
      ? NEVER_ON_A_TIMER
      : `${NEVER_ON_A_TIMER} ${ADMIN_ONLY_RETENTION}`;
  }

  function renderOutstanding() {
    if (!ctx.canReview || !state.outstandingRuns.length) {
      setHidden(el.outstanding, true);
      return;
    }
    const count = state.outstandingRuns.reduce(
      (sum, row) => sum + Number(row.outstanding_count ?? 0),
      0,
    );
    el.outstandingTitle.textContent = `${plural(count, 'photo')} not confirmed deleted from storage`;
    el.finish.disabled = state.busy;
    setHidden(el.outstanding, false);
  }

  function renderHistory() {
    if (!ctx.canReview) {
      setHidden(el.historyTable, true);
      setHidden(el.historyEmpty, true);
      setHidden(el.historyNote, false);
      return;
    }
    setHidden(el.historyNote, true);

    if (!state.runs.length) {
      setHidden(el.historyTable, true);
      setHidden(el.historyEmpty, false);
      return;
    }
    setHidden(el.historyEmpty, true);
    setHidden(el.historyTable, false);
    el.historyRows.replaceChildren(...state.runs.map(historyRow));
  }

  function historyRow(run) {
    const who = state.reviewers.get(run.performed_by) || 'Unknown';
    const when = shortDate(String(run.performed_at ?? '').slice(0, 10));
    const isReclaim = run.kind === 'orphaned_uploads';
    return h(
      'tr',
      {},
      h('td', {}, when),
      h('td', {}, who),
      h('td', { class: 'board-number' }, String(run.evidence_count ?? 0)),
      h(
        'td',
        { class: 'board-number' },
        isReclaim ? 'size unknown' : formatBytes(Number(run.bytes_freed ?? 0)),
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Deleting: the two-step handoff, in one place
  // -------------------------------------------------------------------------

  /**
   * Deletes the given objects from the evidence bucket and marks the ones
   * finish_purge_run() actually confirmed on the run they belong to. Every
   * caller below (a fresh purge, an orphaned-upload reclaim, or finishing an
   * old run) goes through this, so there is one implementation of "some of
   * it did not delete" to get right rather than three.
   *
   * deletedCount and failedCount are read off finish_purge_run()'s own
   * per-path outcome, never off what Storage's bulk delete happened to echo
   * back: those are two different questions, and only the database's answer
   * is the one the officer-facing message and the outstanding-runs list are
   * allowed to trust.
   *
   *   * A path Storage does echo back as deleted is a candidate to finish,
   *     not a confirmed one yet.
   *   * A path Storage does NOT echo back is not automatically a failure:
   *     it might already be gone (deleted out of band, or claimed by a
   *     second purge run racing for the same object_path), and
   *     evidenceObjectExists() is asked directly rather than guessed at. A
   *     path verified gone is still a candidate to finish; a path verified
   *     still there is a real failure and is never sent to finish_purge_run.
   *   * finish_purge_run() itself can fail outright (thrown, not merely
   *     unconfirmed). That is not "the delete already happened, so this is
   *     fine": the database's own bookkeeping did not happen, so nothing
   *     here counts as deleted, and bookkeepingFailed tells every caller to
   *     say so rather than read a Storage-side success as a clean one.
   */
  async function deleteAndFinish(runId, paths) {
    if (!paths.length) return { deletedCount: 0, failedCount: 0, bookkeepingFailed: false };

    let deletedByStorage = [];
    try {
      deletedByStorage = await deleteEvidenceObjects(paths);
    } catch {
      deletedByStorage = [];
    }
    const confirmedByStorage = new Set(deletedByStorage);

    const unconfirmed = paths.filter((path) => !confirmedByStorage.has(path));
    const verifiedAbsent = await Promise.all(
      unconfirmed.map(async (path) => {
        try {
          return { path, exists: await evidenceObjectExists(path) };
        } catch {
          // A check that could not complete is not proof of absence: it is
          // treated the same as "still there" rather than risk marking a
          // real object finished on a guess.
          return { path, exists: true };
        }
      }),
    );

    const toFinish = [
      ...confirmedByStorage,
      ...verifiedAbsent.filter((row) => !row.exists).map((row) => row.path),
    ];
    if (!toFinish.length) {
      return { deletedCount: 0, failedCount: paths.length, bookkeepingFailed: false };
    }

    let outcomes;
    try {
      outcomes = await callRpc('finish_purge_run', { p_run_id: runId, p_object_paths: toFinish });
    } catch {
      // The database never confirmed any of it, whatever Storage did. The
      // run stays outstanding, and the caller has to say so rather than
      // report the photos that did leave the bucket as cleared.
      return { deletedCount: 0, failedCount: paths.length, bookkeepingFailed: true };
    }

    const confirmed = (Array.isArray(outcomes) ? outcomes : []).filter(
      (row) => row.outcome === 'marked_deleted' || row.outcome === 'already_marked',
    ).length;

    return {
      deletedCount: confirmed,
      failedCount: paths.length - confirmed,
      bookkeepingFailed: false,
    };
  }

  // -------------------------------------------------------------------------
  // Review and clear
  // -------------------------------------------------------------------------

  function openPurgeDialog() {
    const rows = state.preview;
    const selected = new Set(rows.map((row) => row.event_id));
    const photoCountOf = new Map(rows.map((row) => [row.event_id, Number(row.photo_count ?? 0)]));

    // docs/03-admin-ui.md section 7: the button counts the photos this run
    // would clear, not the events they came from. The dialog title keeps the
    // event-count wording; only the button sums photo_count across whatever
    // is currently checked.
    const syncConfirm = () => {
      const n = selected.size;
      const photos = [...selected].reduce((sum, id) => sum + (photoCountOf.get(id) ?? 0), 0);
      el.dialogConfirm.disabled = n === 0;
      el.dialogConfirm.textContent = n ? `Clear ${photos}` : 'Clear';
    };

    el.dialogTitle.textContent = `Clear photos from ${plural(rows.length, 'event')}?`;
    el.dialogList.replaceChildren(
      ...rows.map((row) =>
        h(
          'label',
          { class: 'storage-purge-row' },
          h('input', {
            type: 'checkbox',
            checked: true,
            onChange: (event) => {
              if (event.target.checked) selected.add(row.event_id);
              else selected.delete(row.event_id);
              syncConfirm();
            },
          }),
          h('span', { class: 'storage-purge-event' }, row.event_title),
          h(
            'span',
            { class: 'storage-purge-meta' },
            `${shortDate(row.occurred_on)} · ${plural(Number(row.photo_count ?? 0), 'photo')}`,
          ),
        ),
      ),
    );
    syncConfirm();

    return new Promise((resolve) => {
      // Same guard as every other dialog in this product: close() queues its
      // event, so the cancel path can still run after submit already decided.
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        el.dialogForm.removeEventListener('submit', onSubmit);
        el.dialog.removeEventListener('close', onClose);
        resolve(value);
      };
      const onSubmit = () => {
        el.dialog.close();
        finish([...selected]);
      };
      const onClose = () => finish(null);

      el.dialogForm.addEventListener('submit', onSubmit);
      el.dialog.addEventListener('close', onClose, { once: true });
      el.dialog.showModal();
    });
  }

  async function reviewAndClear() {
    if (!state.preview.length) return;
    const eventIds = await openPurgeDialog();
    if (!eventIds || !eventIds.length) return;
    await runPurge(eventIds);
  }

  async function runPurge(eventIds) {
    state.busy = true;
    ctx.clearMessage();
    render();
    try {
      const run = await callRpc('purge_evidence', {
        p_retention_months: state.retentionMonths,
        p_event_ids: eventIds,
      });
      const evidenceCount = Number(run?.evidence_count ?? 0);
      const ineligible = run?.ineligible_event_ids ?? [];
      const { failedCount, bookkeepingFailed } = await deleteAndFinish(
        run?.purge_run_id,
        run?.object_paths ?? [],
      );

      const parts = [];
      if (evidenceCount) parts.push(`${plural(evidenceCount, 'photo')} cleared.`);
      if (bookkeepingFailed) {
        parts.push(BOOKKEEPING_INCOMPLETE);
      } else if (failedCount > 0) {
        parts.push(`${plural(failedCount, 'photo')} could not be deleted from storage.`);
      }
      if (ineligible.length) {
        parts.push(`${plural(ineligible.length, 'event')} no longer eligible.`);
      }
      const said = parts.join(' ') || 'Nothing was cleared.';
      const tone = bookkeepingFailed || failedCount > 0 || ineligible.length ? 'warn' : 'ok';
      ctx.note(said, tone);
      announce(said);
    } catch (err) {
      ctx.fail(err, null);
    } finally {
      state.busy = false;
      await load();
      ctx.onRosterChanged?.();
    }
  }

  // -------------------------------------------------------------------------
  // Orphaned uploads, and finishing a run left outstanding
  // -------------------------------------------------------------------------

  async function reclaimOrphans() {
    state.busy = true;
    ctx.clearMessage();
    render();
    try {
      const run = await callRpc('purge_orphaned_uploads');
      const count = Number(run?.objects_to_delete ?? 0);
      const { failedCount, bookkeepingFailed } = await deleteAndFinish(
        run?.purge_run_id,
        run?.object_paths ?? [],
      );

      const parts = [count ? `${plural(count, 'upload')} reclaimed.` : 'Nothing to reclaim.'];
      if (bookkeepingFailed) {
        parts.push(BOOKKEEPING_INCOMPLETE);
      } else if (failedCount > 0) {
        parts.push(`${plural(failedCount, 'upload')} could not be deleted from storage.`);
      }
      const said = parts.join(' ');
      ctx.note(said, bookkeepingFailed || failedCount > 0 ? 'warn' : 'ok');
      announce(said);
    } catch (err) {
      ctx.fail(err, null);
    } finally {
      state.busy = false;
      await load();
    }
  }

  async function finishOutstanding() {
    state.busy = true;
    ctx.clearMessage();
    render();
    try {
      let deletedCount = 0;
      let failedCount = 0;
      let bookkeepingFailed = false;
      for (const run of state.outstandingRuns) {
        const rows = await select('purge_run_objects', {
          select: 'object_path',
          filters: { purge_run_id: `eq.${run.purge_run_id}`, deleted_at: 'is.null' },
        });
        const paths = (rows ?? []).map((row) => row.object_path);
        const result = await deleteAndFinish(run.purge_run_id, paths);
        deletedCount += result.deletedCount;
        failedCount += result.failedCount;
        bookkeepingFailed = bookkeepingFailed || result.bookkeepingFailed;
      }

      const parts = [];
      if (deletedCount) parts.push(`${plural(deletedCount, 'photo')} confirmed deleted.`);
      if (bookkeepingFailed) parts.push(BOOKKEEPING_INCOMPLETE);
      else if (failedCount) parts.push(`${plural(failedCount, 'photo')} still could not be deleted.`);
      const said = parts.join(' ') || 'Nothing left to confirm.';
      ctx.note(said, bookkeepingFailed || failedCount ? 'warn' : 'ok');
      announce(said);
    } catch (err) {
      ctx.fail(err, null);
    } finally {
      state.busy = false;
      await load();
    }
  }

  // -------------------------------------------------------------------------
  // The retention window
  // -------------------------------------------------------------------------

  async function changeRetention(value) {
    const months = Number(value);
    if (!Number.isFinite(months) || months < 1) return;

    state.busy = true;
    render();
    try {
      const rows = await patch(
        'app_settings',
        { key: 'eq.evidence_retention_months' },
        { value: months },
      );
      if (!rows.length) {
        ctx.note('Nothing was changed. Reload the page.', 'warn');
        return;
      }
      state.retentionMonths = months;
      // The window just changed, so what is "ready to clear" has to be read
      // again at the new window rather than left showing the old one's
      // numbers until the next full reload.
      if (ctx.canReview) {
        state.preview = (await callRpc('fn_purge_preview', { p_retention_months: months })) ?? [];
      }
    } catch (err) {
      ctx.fail(err, null);
    } finally {
      state.busy = false;
      render();
    }
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  function wire() {
    el.review.addEventListener('click', reviewAndClear);
    el.reclaim.addEventListener('click', reclaimOrphans);
    el.finish.addEventListener('click', finishOutstanding);
    el.retentionSelect.addEventListener('change', (event) => changeRetention(event.target.value));
    el.dialog.querySelector('[data-close]')?.addEventListener('click', () => el.dialog.close());
  }

  return {
    mount() {
      wire();
      return load();
    },
    reload: load,
    hasLoaded: () => state.loaded,
  };
}
