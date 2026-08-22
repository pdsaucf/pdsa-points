import test from 'node:test';
import assert from 'node:assert/strict';

import { RpcError } from '../web/src/errors.js';
import { describeOfficer } from '../web/src/officer-errors.js';

test('a missing RPC is an unavailable action, not a database connection failure', () => {
  const copy = describeOfficer(
    new RpcError(
      'PGRST202',
      'Could not find the function public.remove_attendance_record in the schema cache',
      404,
    ),
  );

  assert.equal(copy.title, 'Action unavailable');
  assert.equal(copy.body, 'An admin needs to finish the site update');
  assert.equal(copy.recover, 'none');
  assert.doesNotMatch(`${copy.title} ${copy.body}`, /cannot reach the database/i);
});

test('a mutation can add context without exposing the PostgREST error', () => {
  const backendMessage =
    'Could not find the function public.remove_attendance_record(p_record_id) in the schema cache';
  const copy = describeOfficer(
    new RpcError('PGRST202', backendMessage, 404),
    { title: 'Record not removed' },
  );

  assert.equal(copy.title, 'Record not removed');
  assert.equal(copy.body, 'An admin needs to finish the site update');
  assert.doesNotMatch(copy.body, /schema|function|p_record_id/i);
});

test('an ordinary HTTP 404 keeps the generic connection guidance', () => {
  const copy = describeOfficer(new RpcError('HTTP_404', 'Not found', 404));
  assert.equal(copy.title, 'Cannot reach the database');
  assert.match(copy.body, /connection details/i);
});
