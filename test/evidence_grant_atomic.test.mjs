import test from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers/db.mjs';
import { YEAR_2026 } from './helpers/fixture.mjs';

const EVENT = '22222222-0000-4000-a000-00000000e701';
const MEMBER = '11111111-0000-4000-a000-00000000e701';

test('the grant cap is rechecked after locking a stable event advisory key', async () => {
  const db = await freshDb();
  try {
    await db.exec(`
      insert into events (id, academic_year_id, title, occurred_on, checkin_token)
      values ('${EVENT}', '${YEAR_2026}', 'Atomic Grant Event', current_date, 'tok-atomic-grant');
      insert into members (id, first_name, last_name)
      values ('${MEMBER}', 'Grant', 'Tester');
      update app_settings set value = '1'::jsonb
      where key = 'evidence_grants_outstanding_per_member';
    `);

    await db.q(
      `insert into evidence_upload_grants
         (event_id, member_id, kind, object_path, expires_at)
       values ($1, $2, 'shirt_photo', 'atomic/one.jpg', now() + interval '30 minutes')`,
      [EVENT, MEMBER],
    );

    const refused = await db.expectError(
      `insert into evidence_upload_grants
         (event_id, member_id, kind, object_path, expires_at)
       values ($1, $2, 'shirt_photo', 'atomic/two.jpg', now() + interval '30 minutes')`,
      [EVENT, MEMBER],
    );
    assert.equal(refused.code, 'PDS04');
    assert.equal(
      Number(await db.val(`select count(*) from evidence_upload_grants where event_id = $1`, [EVENT])),
      1,
    );

    const source = await db.val(
      `select pg_get_functiondef('fn_enforce_evidence_grant_caps()'::regprocedure)`,
    );
    assert.match(source, /pg_advisory_xact_lock[\s\S]+evidence-grants:/i);

    await db.q(
      `update evidence_upload_grants set consumed_at = now() where event_id = $1`,
      [EVENT],
    );
    await db.q(
      `insert into evidence_upload_grants
         (event_id, member_id, kind, object_path, expires_at)
       values ($1, $2, 'shirt_photo', 'atomic/two.jpg', now() + interval '30 minutes')`,
      [EVENT, MEMBER],
    );
    assert.equal(
      Number(
        await db.val(
          `select count(*) from evidence_upload_grants
            where event_id = $1 and consumed_at is null`,
          [EVENT],
        ),
      ),
      1,
    );
  } finally {
    await db.close();
  }
});
