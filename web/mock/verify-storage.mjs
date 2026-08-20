// Checks for the storage screen and the purge flow: docs/03-admin-ui.md
// section 7, supabase/migrations/20260815100000_storage_ops.sql.
//
// Same rule as the other suites: assert what fails SILENTLY. A usage bar that
// draws is easy to see. What is not:
//
//   1. THAT THE NUMBERS ARE THE SERVER'S OWN ANSWER. fn_storage_usage() sums
//      attendance_evidence.byte_size, never storage.objects, and the warn
//      threshold is a setting, not a constant baked into the bar. A screen
//      that recomputed either from rows it already had would look right on
//      this fixture and diverge from the database the moment they disagreed.
//   2. THAT PURGING IS SOMETHING A PERSON DECIDES, PER EVENT (invariant 7,
//      invariant 6). The confirmation dialog lists events with checkboxes,
//      not a bare "clear everything past the window" button, and unchecking
//      one really does hold that event's evidence back.
//   3. THAT A HALF-FINISHED DELETE READS AS HALF-FINISHED. purge_evidence()
//      stamps purged_at before the browser ever calls Storage; if that
//      second call fails for some of the objects, the screen has to say so
//      rather than report the clean "N cleared" it would say for a run that
//      fully succeeded, and has to keep offering a way to finish later.
//   4. THAT THE SHARED ADMIN SESSION can read usage, choose retention, and
//      finish the purge operation.
//
// HOW THE SCREEN IS DRIVEN. mock/dom.mjs parses the real admin/index.html and
// admin.js's own start() runs against it, so what is asserted below is the
// rendered DOM of the shipped page, not a module's return value.
//
// Run: node web/mock/verify-storage.mjs   (npm run verify:storage, from web/)

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startMock } from './server.mjs';
import { signInAs as signInAsAccount } from './sign-in.mjs';
import { failRpcOnce, failStorageDeleteOnce, removeFromBucket } from './admin-server.mjs';
import { IDS } from './admin-fixtures.mjs';
import { installDom } from './dom.mjs';

const PORT = 8800;
const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));

globalThis.__PDSA_CONFIG__ = {
  SUPABASE_URL: `http://localhost:${PORT}`,
  SUPABASE_ANON_KEY: 'mock-anon-key',
};

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
  clear: () => store.clear(),
};

const adminHtml = await readFile(`${WEB_ROOT}admin/index.html`, 'utf8');
const adminCss = await readFile(`${WEB_ROOT}assets/css/admin.css`, 'utf8');
const storageSource = await readFile(`${WEB_ROOT}src/storage.js`, 'utf8');
let dom = installDom(adminHtml);

globalThis.window = {
  location: {
    origin: `http://localhost:${PORT}`,
    pathname: '/admin/',
    href: `http://localhost:${PORT}/admin/`,
    replace() {},
  },
  history: { replaceState() {} },
};

const auth = await import('../src/auth.js');
const { select, patch, callRpc, evidenceObjectExists } = await import('../src/rest.js');
const { formatBytes } = await import('../src/format.js');
const { plural } = await import('../src/ui.js');
const { start } = await import('../src/admin.js');

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    process.stdout.write(`  ok    ${name}\n`);
  } catch (err) {
    failures += 1;
    process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`);
  }
}

const api = (path) => fetch(`http://localhost:${PORT}${path}`).then((r) => r.json());
const reset = () => api('/__mock/reset');

const signInAs = (email) => signInAsAccount(email, PORT);

/**
 * Waits for the screen to settle, rather than for a fixed number of turns.
 *
 * Deliberately never keyed on the shared #screen-message strip: the
 * requirements panel mounts in the same start() call this suite drives and,
 * outside a real browser, its own paintProblems() throws on the missing
 * global CSS.escape the moment it runs, which flips that shared strip to a
 * generic failure long before the storage screen's own async load finishes.
 * That is a pre-existing gap in this Node harness (CSS.escape is a real
 * browser API storage.js never touches), not a storage bug, so every wait
 * below is on an element storage.js itself owns.
 */
async function until(predicate, message, timeout = 4000) {
  const stop = Date.now() + timeout;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > stop) throw new Error(`timed out waiting: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** storage.js's own cutoffLabel(), reproduced: 'before <Month Year>'. */
function cutoffLabel(months) {
  const date = new Date();
  date.setMonth(date.getMonth() - Number(months));
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

/**
 * A fresh copy of the shipped page, with the admin shell mounted on it and
 * the storage tab open. Every phase below calls this once per sign-in
 * (verify-portal.mjs's mountPortal() is the same idea): admin.js's start()
 * wires each panel's own click and change listeners onto whatever DOM exists
 * at that moment, and calling it twice against the SAME document would leave
 * two listeners on one button. A fresh installDom() is a fresh set of nodes,
 * which is also the honest analogue of what changes a setting outside this
 * screen (the admin-only quota check below) actually needs: reopening it.
 */
async function mountAdmin() {
  dom = installDom(adminHtml);
  start();
  await until(() => !dom.$('view-app').hidden, 'the shell never signed in');
  dom.click(dom.$('tab-storage'));
  await until(() => !dom.$('storage-body').hidden, 'the storage screen never loaded');
  return dom;
}

const server = await startMock(PORT);

// ---------------------------------------------------------------------------
process.stdout.write('\nhouse rules\n');
// ---------------------------------------------------------------------------

await check('no em dash in anything this screen is made of', async () => {
  const emDash = String.fromCharCode(0x2014);
  const files = {
    'src/storage.js': storageSource,
    'admin/index.html': adminHtml,
    'assets/css/admin.css': adminCss,
    'mock/verify-storage.mjs': await readFile(new URL(import.meta.url), 'utf8'),
  };
  for (const [label, source] of Object.entries(files)) {
    assert.ok(!source.includes(emDash), `${label} contains an em dash`);
  }
});

/** Every string literal that is plainly copy rather than an identifier. */
function uiStrings(source) {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const found = [];
  for (const pattern of [/'((?:[^'\\\n]|\\.)*)'/g, /"((?:[^"\\\n]|\\.)*)"/g, /`((?:[^`\\]|\\.)*)`/g]) {
    for (const match of withoutComments.matchAll(pattern)) {
      const text = match[1];
      if (!text) continue;
      if (!/\s/.test(text) && !/[A-Z]/.test(text)) continue;
      found.push(text);
    }
  }
  return found;
}

await check('the database vocabulary never reaches this screen', () => {
  const banned = [
    'node', 'nodes', 'threshold', 'schema', 'RLS', 'PostgREST', 'uuid', 'jsonb',
    'foreign key', 'purge_run', 'app_settings', 'bucket',
  ];
  // Only the storage section of admin/index.html: the markup for every other
  // screen is somebody else's copy to answer for.
  const storageMarkup = /<main id="panel-storage"[\s\S]*?<\/main>/.exec(adminHtml)?.[0] ?? '';
  const dialogMarkup = /<dialog id="storage-purge-dialog"[\s\S]*?<\/dialog>/.exec(adminHtml)?.[0] ?? '';
  const copy = [
    ...uiStrings(storageSource).map((text) => ['src/storage.js', text]),
    [
      'admin/index.html',
      (storageMarkup + dialogMarkup).replace(/<!--[\s\S]*?-->/g, ' '),
    ],
  ];
  for (const [label, text] of copy) {
    for (const word of banned) {
      assert.doesNotMatch(
        text,
        new RegExp(`\\b${word.replace(/ /g, '\\s+')}\\b`, 'i'),
        `${label} shows the word "${word}": ${JSON.stringify(String(text).slice(0, 90))}`,
      );
    }
  }
});

await check('every column of digits on this screen is tabular', () => {
  for (const selector of ['.storage-usage-count', '.usage-line', '.storage-purge-meta']) {
    const block = new RegExp(`\\${selector}\\s*\\{[^}]*font-variant-numeric:\\s*tabular-nums`);
    assert.match(adminCss, block, `${selector} does not line its digits up`);
  }
  // The history table rides .board's own tabular rule (verify-board.mjs holds
  // that generally); here it only has to be the class the markup actually uses.
  assert.match(adminHtml, /id="storage-history-table" class="board board-plain"/);
});

await check('the two spec lines in the confirmation dialog are the real ones', () => {
  assert.match(adminHtml, /Attendance records, points and Honorary status are all kept\./);
  assert.match(adminHtml, /Only the photos are deleted\. This can't be undone\./);
});

// ---------------------------------------------------------------------------
process.stdout.write('\nan officer clears photos\n');
// ---------------------------------------------------------------------------

await reset();
await signInAs('officers@pdsaucf.com');
await mountAdmin();

await check('the usage bar is the server figure, rendered, not a client sum', async () => {
  const [usage] = await callRpc('fn_storage_usage');
  assert.equal(
    dom.$('storage-usage-count').textContent,
    `${plural(usage.photo_count, 'photo')} · ${formatBytes(usage.bytes_held)}`,
  );
  assert.equal(
    dom.$('storage-usage-line').textContent,
    `${formatBytes(usage.bytes_held)} of ${formatBytes(usage.quota_bytes)}`,
  );
  assert.equal(dom.$('storage-usage-fill').style.width, `${usage.percent_used}%`);
  // Well under the 75% default warn line on a fresh fixture.
  assert.equal(dom.$('storage-usage-bar').dataset.warn, 'false');
});

await check('the orphaned upload is shown to an officer, size marked unknown', () => {
  assert.equal(dom.$('storage-orphaned').hidden, false);
  assert.match(dom.$('storage-orphaned-text').textContent, /1 upload never submitted, size unknown\./);
});

await check('"ready to clear" is the live preview, not a hardcoded count', async () => {
  const rows = await callRpc('fn_purge_preview', { p_retention_months: 12 });
  const totalPhotos = rows.reduce((sum, row) => sum + Number(row.photo_count ?? 0), 0);
  const totalBytes = rows.reduce((sum, row) => sum + Number(row.bytes ?? 0), 0);

  assert.equal(dom.$('storage-ready').hidden, false);
  assert.equal(
    dom.$('storage-ready-body').textContent,
    `${plural(totalPhotos, 'photo')} from ${plural(rows.length, 'event')} ` +
      `before ${cutoffLabel(12)}. All of them have been reviewed. Frees about ${formatBytes(totalBytes)}.`,
  );

  // The eligibility rule, proven against fixtures this suite controls rather
  // than against the total (which a fixture elsewhere could add to over
  // time): the three old, reviewed events are in the preview, and the old
  // but still-pending event and the reviewed-but-recent event are not.
  const titles = rows.map((row) => row.event_title);
  assert.ok(titles.includes('Career Night'), 'an old, approved event is missing from the preview');
  assert.ok(titles.includes('Movie Night'), 'an old, approved event is missing from the preview');
  assert.ok(titles.includes('Blood Drive'), 'an old, REJECTED event is missing from the preview');
  assert.ok(!titles.includes('Beach Cleanup'), 'a still-pending record was offered for purging');
  assert.ok(!titles.includes('Trivia Night'), 'an event inside the retention window was offered for purging');

  const careerNight = rows.find((row) => row.event_title === 'Career Night');
  assert.equal(Number(careerNight.photo_count), 2, 'an already-purged photo at this event was counted again');
});

await check('the shared admin history identifies the session and amount', () => {
  const rowsText = dom.$('storage-history-rows').rowsText;
  assert.equal(rowsText.length, 3);
  assert.equal(rowsText.filter((row) => row.includes('Admin')).length, 3);
  // The orphaned-uploads kind never claims a byte figure it cannot know.
  assert.ok(rowsText.some((row) => row.includes('size unknown')), 'an orphaned-uploads run claimed a byte count');
});

let dialogRows;
let confirmLabel;
let previewRows;

await check('the confirmation dialog lists events with checkboxes, not a bare button', async () => {
  // docs/03-admin-ui.md section 7: the button counts photos, not events
  // ("Clear 318" for 318 photos from 11 events). Fetched independently of
  // the dialog so this check proves the button against the server's own
  // photo_count, not against a number the dialog merely echoes back.
  previewRows = await callRpc('fn_purge_preview', { p_retention_months: 12 });

  dom.click(dom.$('storage-review'));
  assert.equal(dom.$('storage-purge-dialog').open, true, 'Review and clear did not open the dialog');

  dialogRows = dom.$('storage-purge-list').querySelectorAll('.storage-purge-row');
  confirmLabel = () => dom.$('storage-purge-confirm').textContent;

  assert.ok(dialogRows.length >= 3, 'the dialog does not list the events this suite seeded');
  for (const row of dialogRows) {
    const box = row.querySelector('input[type="checkbox"]');
    assert.ok(box, 'a row in the dialog has no checkbox');
    assert.equal(box.checked, true, 'a row did not default to checked');
  }
  const totalPhotos = previewRows.reduce((sum, row) => sum + Number(row.photo_count ?? 0), 0);
  assert.ok(totalPhotos > dialogRows.length, 'this fixture no longer has an event with more than one photo');
  assert.equal(confirmLabel(), `Clear ${totalPhotos}`);
});

await check('unchecking an event drops the photo count on the confirm button, not the event count', () => {
  const movieNight = dialogRows.find((row) => row.textContent.includes('Movie Night'));
  assert.ok(movieNight, 'Movie Night is not one of the dialog rows');
  const movieNightPreview = previewRows.find((row) => row.event_title === 'Movie Night');
  const box = movieNight.querySelector('input[type="checkbox"]');
  box.checked = false;
  dom.fire(box, 'change');

  const totalPhotos = previewRows.reduce((sum, row) => sum + Number(row.photo_count ?? 0), 0);
  assert.equal(confirmLabel(), `Clear ${totalPhotos - Number(movieNightPreview.photo_count)}`);
});

await check('an event held back is not purged, and one Storage cannot confirm is reported', async () => {
  // The object this run should fail to confirm deleting: one of Career
  // Night's two photos. Fetched by the record id this suite seeded, not
  // guessed, so the injected failure names a real path.
  const [evidence] = await select('attendance_evidence', {
    select: 'object_path',
    filters: { attendance_record_id: `eq.${IDS.STORAGE.RECORD_OLD_A_1}` },
  });
  failStorageDeleteOnce([evidence.object_path]);

  const historyBefore = dom.$('storage-history-rows').querySelectorAll('tr').length;
  dom.fire(dom.$('storage-purge-form'), 'submit');
  await until(
    () => dom.$('storage-history-rows').querySelectorAll('tr').length > historyBefore,
    'the purge never completed',
  );

  // Movie Night, held back by unchecking it, is untouched.
  const [movieEvidence] = await select('attendance_evidence', {
    select: 'purged_at',
    filters: { attendance_record_id: `eq.${IDS.STORAGE.RECORD_OLD_B}` },
  });
  assert.equal(movieEvidence.purged_at, null, 'an event unchecked in the dialog was purged anyway');

  // Career Night and Blood Drive, left checked, are purged in the database
  // regardless of whether Storage confirmed the delete: purged_at is stamped
  // before the browser ever calls Storage.
  const [careerA1] = await select('attendance_evidence', {
    select: 'purged_at',
    filters: { attendance_record_id: `eq.${IDS.STORAGE.RECORD_OLD_A_1}` },
  });
  const [rejected] = await select('attendance_evidence', {
    select: 'purged_at',
    filters: { attendance_record_id: `eq.${IDS.STORAGE.RECORD_REJECTED}` },
  });
  assert.ok(careerA1.purged_at, 'a checked event was not purged');
  assert.ok(rejected.purged_at, 'a checked, REJECTED event was not purged');

  // The screen says so: a partial Storage failure is never a clean success.
  assert.equal(dom.$('screen-message').dataset.tone, 'warn');
  assert.match(dom.$('screen-message-title').textContent, /cleared/);
  assert.match(dom.$('screen-message-title').textContent, /could not be deleted from storage/);
});

await check('the object Storage never confirmed shows up as outstanding', () => {
  // 2 from the fixture run, plus the 1 this suite just forced to fail.
  assert.equal(dom.$('storage-outstanding').hidden, false);
  assert.equal(dom.$('storage-outstanding-title').textContent, '3 photos not confirmed deleted from storage');
});

await check('Finish deleting closes out every run left outstanding, fixture and fresh alike', async () => {
  dom.click(dom.$('storage-finish'));
  await until(() => dom.$('storage-outstanding').hidden === true, 'the outstanding notice never cleared');

  const outstanding = await select('v_purge_runs_outstanding', {
    select: 'purge_run_id',
  });
  assert.equal(outstanding.length, 0, 'a run is still outstanding after Finish deleting');
});

// ---------------------------------------------------------------------------
process.stdout.write('\na run only partly confirms, and says so\n');
// ---------------------------------------------------------------------------
// Reuses the fixture's own outstanding run (two objects, deliberately never
// confirmed deleted) rather than driving a fresh purge through the dialog:
// what is under test here is deleteAndFinish() itself, not the dialog.

await reset();
await signInAs('officers@pdsaucf.com');
await mountAdmin();

let outstandingPaths;

await check('the fixture outstanding run starts with two unconfirmed objects', async () => {
  outstandingPaths = (
    await select('purge_run_objects', {
      select: 'object_path',
      filters: { purge_run_id: `eq.${IDS.STORAGE.runOutstanding}`, deleted_at: 'is.null' },
    })
  ).map((row) => row.object_path);
  assert.equal(outstandingPaths.length, 2, 'the fixture no longer seeds two unconfirmed objects');
  assert.equal(
    dom.$('storage-outstanding-title').textContent,
    '2 photos not confirmed deleted from storage',
  );
});

await check(
  'an object verified gone from the bucket is finished; one Storage genuinely still holds is not',
  async () => {
    const [gone, stillThere] = outstandingPaths;
    // Two different reasons a bulk delete's response can fail to echo a
    // path back. removeFromBucket simulates the object already being gone
    // when the delete call runs (out of band, or a second purge run racing
    // for the same object_path); failStorageDeleteOnce simulates Storage
    // genuinely failing to remove an object that is still there.
    removeFromBucket([gone]);
    failStorageDeleteOnce([stillThere]);

    dom.click(dom.$('storage-finish'));
    await until(
      () => dom.$('storage-outstanding-title').textContent === '1 photo not confirmed deleted from storage',
      'the verified-gone object was not finished, or the still-present one was',
    );

    assert.equal(dom.$('screen-message').dataset.tone, 'warn');
    assert.match(dom.$('screen-message-title').textContent, /1 photo confirmed deleted/);
    assert.match(dom.$('screen-message-title').textContent, /1 photo still could not be deleted/);

    const stillUnconfirmed = (
      await select('purge_run_objects', {
        select: 'object_path',
        filters: { purge_run_id: `eq.${IDS.STORAGE.runOutstanding}`, deleted_at: 'is.null' },
      })
    ).map((row) => row.object_path);
    assert.deepEqual(stillUnconfirmed, [stillThere], 'the wrong object was left outstanding');
  },
);

await check(
  'a Storage delete that succeeds but cannot be confirmed is never read as a clean success',
  async () => {
    const [, stillThere] = outstandingPaths;
    // This time nothing stops Storage from actually deleting the object:
    // the call that is supposed to confirm it in the database is the one
    // that dies.
    failRpcOnce('finish_purge_run');

    dom.click(dom.$('storage-finish'));
    await until(
      () => dom.$('screen-message-title').textContent.includes('Bookkeeping incomplete'),
      'a failed finish_purge_run was not reported',
    );

    assert.equal(dom.$('screen-message').dataset.tone, 'warn');

    // The run stays outstanding: the database's own bookkeeping never
    // confirmed anything, whatever happened to the bytes in the bucket.
    const outstanding = await select('v_purge_runs_outstanding', {
      select: 'purge_run_id,outstanding_count',
      filters: { purge_run_id: `eq.${IDS.STORAGE.runOutstanding}` },
    });
    assert.equal(outstanding.length, 1, 'the run dropped out of outstanding on a failed bookkeeping call');
    assert.equal(Number(outstanding[0].outstanding_count), 1);

    // The bytes really are gone from the bucket, even though nothing on
    // screen says so yet: this is what "finished but unconfirmed" means,
    // and it is exactly the gap the next retry (below) closes.
    const stillInBucket = await evidenceObjectExists(stillThere);
    assert.equal(stillInBucket, false, 'Storage still holds an object it already reported deleting');
  },
);

await check('retrying finds the same object already gone, and closes the run out', async () => {
  dom.click(dom.$('storage-finish'));
  await until(() => dom.$('storage-outstanding').hidden === true, 'the outstanding notice never cleared');

  const outstanding = await select('v_purge_runs_outstanding', {
    select: 'purge_run_id',
    filters: { purge_run_id: `eq.${IDS.STORAGE.runOutstanding}` },
  });
  assert.equal(outstanding.length, 0, 'the run is still outstanding after the object was actually gone');
});

// ---------------------------------------------------------------------------
process.stdout.write('\nthe shared admin moves the retention window\n');
// ---------------------------------------------------------------------------

await reset();
await signInAs('officers@pdsaucf.com');
await mountAdmin();

await check('the shared admin sees the retention control as a menu, editable', () => {
  assert.equal(dom.$('storage-retention-select').hidden, false);
  assert.equal(dom.$('storage-retention-text').hidden, true);
  assert.equal(dom.$('storage-retention-select').value, '12');
});

await check('past the 75% warn line, the bar says so, and the setting is what moved it', async () => {
  const [before] = await callRpc('fn_storage_usage');
  assert.ok(before.percent_used < 75, 'the fixture is already past warn, so this proves nothing');

  // Nothing on this screen edits the quota (only the retention window is a
  // control here), so the honest way to prove the bar reads the setting
  // rather than a number it once computed is the same thing an admin who
  // changed it from Supabase directly would do: open the screen again.
  const targetQuota = Math.round(Number(before.bytes_held) / 0.8);
  const written = await patch(
    'app_settings',
    { key: 'eq.storage_quota_bytes' },
    { value: targetQuota },
  );
  assert.equal(written.length, 1, 'an admin could not set the quota');

  await mountAdmin();
  assert.equal(dom.$('storage-usage-bar').dataset.warn, 'true', 'the usage bar never crossed into its warn state');
  assert.match(dom.$('storage-usage-line').textContent, /of/);

  // Restored, so the rest of this suite is not reading a screen an earlier
  // check quietly detuned.
  await patch('app_settings', { key: 'eq.storage_quota_bytes' }, { value: 1073741824 });
});

await check('a wider window purges fewer events, because the preview took the argument seriously', async () => {
  const before = await callRpc('fn_purge_preview', { p_retention_months: 12 });
  assert.ok(before.some((row) => row.event_title === 'Career Night'), 'the fixture is not eligible at 12 months');

  const select_ = dom.$('storage-retention-select');
  select_.value = '240';
  dom.fire(select_, 'change');
  await until(
    () => dom.$('storage-ready').hidden === true,
    'the preview did not shrink to nothing at a 20-year window',
  );

  const rows = await select('app_settings', {
    select: 'value',
    filters: { key: 'eq.evidence_retention_months' },
  });
  assert.equal(Number(rows[0].value), 240, 'the select changed on screen but the setting was not written');
});

// ---------------------------------------------------------------------------

process.stdout.write(`\n${failures === 0 ? 'All checks passed' : `${failures} check(s) FAILED`}\n`);
server.close();
process.exit(failures === 0 ? 0 : 1);
