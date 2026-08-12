// The check-in page controller.
//
// The whole flow lives here because it is one screen and one decision: who are
// you, what does this event need from you, send it. Everything that talks to
// Supabase is in api.js, everything a member reads when something fails is in
// errors.js.
//
// Two rules shape the awkward parts:
//   1. Never lose a photo somebody already took. The compressed bytes and the
//      upload grant survive a failed submit, a retry and a page reload.
//   2. Never turn away somebody who actually showed up. Where a refusal is
//      recoverable, the page recovers on its own before it says anything.

import { IS_CONFIGURED, EVIDENCE_BUCKET } from '../config.js';
import { rpc, uploadEvidence, RpcError } from './api.js';
import { describe, NOT_CONFIGURED, NO_TOKEN } from './errors.js';
import { compressPhoto, ImageTooLargeError, MAX_INPUT_BYTES } from './image.js';
import {
  formatEventDate,
  formatCloseTime,
  firstName,
  valueFieldLabel,
  formatBytes,
  evidencePrompt,
} from './format.js';

const SEARCH_DEBOUNCE_MS = 250;
const MIN_SEARCH_LENGTH = 3;
// Grants live 30 minutes. Restoring one at 25 leaves time to submit against it.
const EVIDENCE_REUSE_MS = 25 * 60 * 1000;

const $ = (id) => document.getElementById(id);

const el = {};
const state = {
  token: null,
  nonce: null,
  context: null,
  member: null, // { id, display_name }
  claimed: null, // { name, email }
  photo: null, // { blob, sha256, contentType, byteSize, kind }
  photoError: null, // { error, stage } from the last failed upload attempt
  // Grants this page has been issued and not yet handed to submit_checkin.
  // Each retaken photo abandons one, and the server caps a single client at
  // three outstanding, so this is what tells a PDS04 caused by the member's
  // own retakes apart from one caused by anything else.
  outstandingGrants: 0,
  evidence: [], // [{ upload_token, sha256, content_type, byte_size }]
  requiredKinds: [],
  submitting: false,
  searchSeq: 0,
  searchAbort: null,
  searchTimer: null,
  results: [],
  activeIndex: -1,
  allowMissingPhoto: false,
};

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function show(view) {
  for (const name of ['loading', 'blocked', 'form', 'done']) {
    el[`view${name}`].hidden = name !== view;
  }
}

function announce(message) {
  el.live.textContent = message;
}

/** Joins a title and a body for a screen reader without doubling the full stop. */
function spoken(title, body) {
  const head = /[.!?]$/.test(title) ? title : `${title}.`;
  return [head, body].filter(Boolean).join(' ');
}

function showBlocked(copy, onRetry) {
  el.blockedTitle.textContent = copy.title;
  el.blockedBody.textContent = copy.body;
  el.blockedRetry.hidden = !copy.retry;
  el.blockedRetry.onclick = onRetry ?? (() => window.location.reload());
  show('blocked');
  announce(spoken(copy.title, copy.body));
}

function showFormMessage(copy) {
  if (!copy) {
    el.formMessage.hidden = true;
    // Clear the two paragraphs, never the container: emptying the container
    // deletes the paragraphs and the next message has nowhere to go.
    el.formMessageTitle.textContent = '';
    el.formMessageBody.textContent = '';
    el.formMessageRetake.hidden = true;
    el.formMessageSkip.hidden = true;
    return;
  }
  el.formMessageTitle.textContent = copy.title;
  el.formMessageBody.textContent = copy.body;
  el.formMessage.hidden = false;
  el.formMessageRetake.hidden = !copy.retakePhoto;
  el.formMessageSkip.hidden = !copy.offerSkipPhoto;
  announce(spoken(copy.title, copy.body));
  const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  el.formMessage.scrollIntoView({ block: 'nearest', behavior: smooth ? 'smooth' : 'auto' });
}

function showDone(title, lines) {
  el.doneTitle.textContent = title;
  el.doneBody.replaceChildren(
    ...lines.filter(Boolean).map((text) => {
      const p = document.createElement('p');
      p.textContent = text;
      return p;
    }),
  );
  show('done');
  announce(spoken(title, lines.filter(Boolean).join(" ")));
}

// ---------------------------------------------------------------------------
// Evidence that survives a failed submit or a reload
// ---------------------------------------------------------------------------

const evidenceKey = () => `pdsa:checkin:${state.token}:evidence`;

function saveEvidence() {
  try {
    if (!state.evidence.length) {
      sessionStorage.removeItem(evidenceKey());
      return;
    }
    sessionStorage.setItem(
      evidenceKey(),
      JSON.stringify({ savedAt: Date.now(), entries: state.evidence }),
    );
  } catch {
    // Private browsing can refuse storage. The in-memory copy still covers the
    // case that matters most, which is a failed submit inside one page view.
  }
}

function restoreEvidence() {
  try {
    const raw = sessionStorage.getItem(evidenceKey());
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed?.entries?.length) return;
    if (Date.now() - parsed.savedAt > EVIDENCE_REUSE_MS) {
      sessionStorage.removeItem(evidenceKey());
      return;
    }
    state.evidence = parsed.entries;
  } catch {
    state.evidence = [];
  }
}

function clearEvidence() {
  state.evidence = [];
  state.photo = null;
  saveEvidence();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const RETRY_NOTE = {
  network: 'Connection dropped. Trying again.',
  busy: 'Lots of people are checking in. Trying again.',
};

async function loadContext() {
  show('loading');
  el.loadingNote.hidden = true;
  try {
    const context = await rpc(
      'get_checkin_context',
      { p_token: state.token },
      {
        attempts: 4,
        onRetry: ({ reason }) => {
          el.loadingNote.textContent = RETRY_NOTE[reason];
          el.loadingNote.hidden = false;
        },
      },
    );
    // Every later call carries this. Without it the limiter puts this browser
    // in the bucket the whole room shares, which behaves perfectly until the
    // room is 167 people and then turns most of them away.
    state.nonce = context?.client_nonce ?? null;
    state.context = context;
    renderForm();
  } catch (err) {
    showBlocked(describe(err, 'context'), loadContext);
  }
}

function renderForm() {
  const event = state.context?.event ?? {};
  el.eventTitle.textContent = event.title ?? 'Check in';

  const bits = [formatEventDate(event.occurred_on)];
  if (event.location) bits.push(event.location);
  el.eventMeta.textContent = bits.filter(Boolean).join(' · ');

  const closes = formatCloseTime(event.closes_at);
  el.eventCloses.textContent = closes ? `Check-in closes at ${closes}` : '';
  el.eventCloses.hidden = !closes;

  // The number field, when this event has a category that reads one.
  const collect = state.context?.collect_value ?? null;
  if (collect) {
    el.valueLabel.textContent = valueFieldLabel(collect);
    el.valueBlock.hidden = false;
  } else {
    el.valueBlock.hidden = true;
  }

  // The photo, when this event asks for one.
  const requirements = state.context?.evidence_requirements ?? [];
  state.requiredKinds = requirements.filter((r) => r.is_required).map((r) => r.kind);
  const requirement = requirements[0] ?? null;
  if (requirement) {
    el.photoBlock.hidden = false;
    el.photoPrompt.textContent = evidencePrompt(requirement);
    el.photoOptional.hidden = requirement.is_required;
    el.photoInput.dataset.kind = requirement.kind;
    if (state.evidence.length) {
      setPhotoStatus('ready', 'Photo already sent.');
      el.photoRetake.hidden = false;
    }
  } else {
    el.photoBlock.hidden = true;
  }

  show('form');
  el.nameInput.focus({ preventScroll: true });
}

// ---------------------------------------------------------------------------
// Name search
// ---------------------------------------------------------------------------

/**
 * The roster starts empty, so at the first event of the year every search comes
 * back with nothing and the name-and-email route is the normal way in, not a
 * failure. When that happens the button below the results is promoted to look
 * like the next step, because it is.
 */
function promoteClaimedRoute(promote) {
  el.noNameButton.classList.toggle('is-promoted', promote);
}

function renderResultsHint(text) {
  state.results = [];
  state.activeIndex = -1;
  el.results.replaceChildren();
  el.resultsHint.textContent = text;
  el.resultsHint.hidden = false;
  el.nameInput.setAttribute('aria-expanded', 'false');
  el.nameInput.removeAttribute('aria-activedescendant');
}

function renderResults(rows) {
  state.results = rows;
  state.activeIndex = -1;
  el.nameInput.removeAttribute('aria-activedescendant');

  if (!rows.length) {
    promoteClaimedRoute(true);
    renderResultsHint('No match on the roster. Use the button below.');
    announce('No match on the roster. Use the button below.');
    return;
  }

  promoteClaimedRoute(false);
  el.resultsHint.hidden = true;
  el.results.replaceChildren(
    ...rows.map((row, index) => {
      const option = document.createElement('li');
      option.className = 'result';
      option.id = `result-${index}`;
      option.role = 'option';
      option.setAttribute('aria-selected', 'false');
      option.textContent = row.display_name;
      option.addEventListener('click', () => selectMember(row));
      return option;
    }),
  );
  el.nameInput.setAttribute('aria-expanded', 'true');
  announce(`${rows.length} name${rows.length === 1 ? '' : 's'} found.`);
}

function moveActive(delta) {
  if (!state.results.length) return;
  const next = state.activeIndex + delta;
  state.activeIndex = next < 0 ? state.results.length - 1 : next % state.results.length;
  [...el.results.children].forEach((node, index) => {
    const active = index === state.activeIndex;
    node.classList.toggle('is-active', active);
    node.setAttribute('aria-selected', active ? 'true' : 'false');
    if (active) node.scrollIntoView({ block: 'nearest' });
  });
  el.nameInput.setAttribute('aria-activedescendant', `result-${state.activeIndex}`);
}

async function runSearch(query) {
  const seq = ++state.searchSeq;
  state.searchAbort?.abort();
  const controller = new AbortController();
  state.searchAbort = controller;

  try {
    const rows = await rpc(
      'search_members',
      { p_token: state.token, p_q: query, p_client_nonce: state.nonce },
      // One short wait if the limiter says busy, and no more: a search is
      // cheap to repeat and somebody typing will not wait a minute for a list.
      { attempts: 3, rateLimitAttempts: 1, signal: controller.signal },
    );
    if (seq !== state.searchSeq) return;
    renderResults(Array.isArray(rows) ? rows : []);
  } catch (err) {
    if (controller.signal.aborted) return;
    if (seq !== state.searchSeq) return;
    // PDS03 here only ever means "shorter than three letters", which the input
    // handler already prevents, so it is not worth a message.
    if (err instanceof RpcError && err.code === 'PDS03') return;
    const copy = describe(err, 'search');
    // A search that cannot run must not strand anybody: the name and email
    // route does not depend on it, so point at it.
    promoteClaimedRoute(true);
    renderResultsHint(`${copy.title}. ${copy.body} You can still check in below.`);
  }
}

function onSearchInput() {
  const query = el.nameInput.value.trim();
  clearTimeout(state.searchTimer);

  if (query.length < MIN_SEARCH_LENGTH) {
    state.searchSeq += 1;
    state.searchAbort?.abort();
    renderResultsHint('Type at least three letters of your name.');
    return;
  }

  el.resultsHint.textContent = 'Looking…';
  el.resultsHint.hidden = state.results.length > 0;
  state.searchTimer = setTimeout(() => runSearch(query), SEARCH_DEBOUNCE_MS);
}

function onSearchKeydown(event) {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    moveActive(1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    moveActive(-1);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    if (state.activeIndex >= 0) selectMember(state.results[state.activeIndex]);
  } else if (event.key === 'Escape') {
    el.nameInput.value = '';
    renderResultsHint('Type at least three letters of your name.');
  }
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

function selectMember(row) {
  if (!row) return;
  state.member = row;
  state.claimed = null;
  clearTimeout(state.searchTimer);
  state.searchAbort?.abort();

  el.chosenName.textContent = row.display_name;
  el.searchBlock.hidden = true;
  el.claimedBlock.hidden = true;
  el.chosenBlock.hidden = false;
  showFormMessage(null);
  announce(`Checking in as ${row.display_name}.`);
  el.changeName.focus({ preventScroll: true });
}

function backToSearch() {
  state.member = null;
  state.claimed = null;
  el.chosenBlock.hidden = true;
  el.claimedBlock.hidden = true;
  el.searchBlock.hidden = false;
  el.nameInput.value = '';
  renderResultsHint('Type at least three letters of your name.');
  showFormMessage(null);
  el.nameInput.focus({ preventScroll: true });
}

function openClaimedForm() {
  state.member = null;
  clearTimeout(state.searchTimer);
  state.searchAbort?.abort();
  el.searchBlock.hidden = true;
  el.chosenBlock.hidden = true;
  el.claimedBlock.hidden = false;
  showFormMessage(null);
  el.claimedName.focus({ preventScroll: true });
}

// ---------------------------------------------------------------------------
// Photo
// ---------------------------------------------------------------------------

function setPhotoStatus(kind, text) {
  el.photoStatus.dataset.kind = kind;
  el.photoStatus.textContent = text;
  el.photoStatus.hidden = !text;
}

async function onPhotoChosen(event) {
  const file = event.target.files?.[0];
  el.photoInput.value = ''; // so choosing the same file twice still fires
  if (!file) return;

  showFormMessage(null);
  state.allowMissingPhoto = false;
  state.photoError = null;
  clearEvidence();
  el.photoRetake.hidden = true;
  setPhotoStatus('working', 'Preparing the photo…');

  let compressed;
  try {
    compressed = await compressPhoto(file);
  } catch (err) {
    if (err instanceof ImageTooLargeError) {
      setPhotoStatus(
        'error',
        `That photo is ${formatBytes(err.bytes)}, over the ${formatBytes(MAX_INPUT_BYTES)} limit. Take it again at a lower resolution.`,
      );
    } else {
      setPhotoStatus('error', 'That file is not a photo. Take it again.');
    }
    return;
  }

  compressed.kind = el.photoInput.dataset.kind || 'other_photo';
  state.photo = compressed;

  el.photoPreview.src = URL.createObjectURL(compressed.blob);
  el.photoPreview.hidden = false;
  // "Retake photo" is the button below the preview. Renaming this one to say
  // the same thing twice would be two buttons for one action.
  el.photoRetake.hidden = false;

  await sendPhoto();
}

/**
 * Grant, then PUT. Kept separate from the submit so a member can be filling in
 * the rest of the form while the bytes are already on their way, and so a
 * failure here can be retried at submit time without a retake.
 */
async function sendPhoto() {
  if (!state.photo || state.evidence.length) return true;

  setPhotoStatus('working', 'Sending photo…');
  let stage = 'grant';
  try {
    const grant = await rpc(
      'create_evidence_upload',
      {
        p_token: state.token,
        p_member_id: state.member?.id ?? null,
        p_kind: state.photo.kind,
        p_client_nonce: state.nonce,
      },
      {
        attempts: 3,
        onRetry: ({ reason }) =>
          setPhotoStatus(
            'working',
            reason === 'busy' ? 'Busy. Still sending the photo…' : 'Slow connection. Still sending…',
          ),
      },
    );

    state.outstandingGrants += 1;

    stage = 'upload';
    await uploadEvidence(grant.object_path, state.photo.blob, {
      bucket: grant.bucket ?? EVIDENCE_BUCKET,
      attempts: 4,
      onRetry: () => setPhotoStatus('working', 'Slow connection. Still sending…'),
    });

    state.evidence = [
      {
        upload_token: grant.upload_token,
        sha256: state.photo.sha256,
        content_type: state.photo.contentType,
        byte_size: state.photo.byteSize,
      },
    ];
    saveEvidence();
    setPhotoStatus('ready', `Photo sent (${formatBytes(state.photo.byteSize)}).`);
    return true;
  } catch (err) {
    state.photoError = { error: err, stage, outstandingGrants: state.outstandingGrants };
    const copy = describe(err, stage, { outstandingGrants: state.outstandingGrants });
    if (copy.retakePhoto) {
      // The grant is gone, so the bytes on this phone are no longer usable.
      state.photo = null;
      URL.revokeObjectURL(el.photoPreview.src);
      el.photoPreview.hidden = true;
      setPhotoStatus('error', `${copy.title}. ${copy.body}`);
    } else {
      setPhotoStatus('error', 'Photo not sent yet. Tap Check in to send it again.');
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

function collectIdentity() {
  if (state.member) return { p_member_id: state.member.id };

  const name = el.claimedName.value.trim();
  const email = el.claimedEmail.value.trim();
  if (!el.claimedBlock.hidden) {
    if (!name) {
      showFormMessage({
        title: 'Enter your full name',
        body: 'Use the name you signed up with.',
      });
      el.claimedName.focus();
      return null;
    }
    if (!email) {
      showFormMessage({
        title: 'Enter your email',
        body: 'An officer uses it to match you to the roster.',
      });
      el.claimedEmail.focus();
      return null;
    }
    state.claimed = { name, email };
    return { p_claimed_name: name, p_claimed_email: email };
  }

  showFormMessage({
    title: 'Pick your name first',
    body: 'Type three letters, then tap your name.',
  });
  el.nameInput.focus();
  return null;
}

function collectValue() {
  if (!state.context?.collect_value) return { ok: true, value: null };
  const raw = el.valueInput.value.trim();
  const label = valueFieldLabel(state.context.collect_value).toLowerCase();
  if (!raw) {
    showFormMessage({
      title: `Enter your ${label}`,
      body: '',
    });
    el.valueInput.focus();
    return { ok: false };
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    showFormMessage({
      title: 'That is not a number',
      body: `Enter your ${label} as a number, for example 2 or 2.5.`,
    });
    el.valueInput.focus();
    return { ok: false };
  }
  return { ok: true, value };
}

function setSubmitting(on) {
  state.submitting = on;
  el.submitButton.disabled = on;
  el.submitButton.setAttribute('aria-busy', on ? 'true' : 'false');
  el.submitLabel.textContent = on ? 'Checking in…' : 'Check in';
}

async function onSubmit(event) {
  event.preventDefault();
  if (state.submitting) return;

  showFormMessage(null);

  const identity = collectIdentity();
  if (!identity) return;

  const value = collectValue();
  if (!value.ok) return;

  setSubmitting(true);
  try {
    // A photo that has not gone through yet gets one more go before we file
    // anything, using the bytes already on this phone.
    if (state.photo && !state.evidence.length) {
      await sendPhoto();
    }

    const photoRequired = state.requiredKinds.length > 0;
    if (photoRequired && !state.evidence.length && !state.allowMissingPhoto) {
      let copy;
      if (!state.photo && state.photoError) {
        // The upload was refused outright and the bytes were dropped, so say
        // what the refusal actually was rather than "take a photo".
        copy = describe(state.photoError.error, state.photoError.stage, {
          outstandingGrants: state.photoError.outstandingGrants,
        });
      } else if (state.photo) {
        copy = {
          title: 'The photo has not sent yet',
          body: 'Try again in a moment.',
          offerSkipPhoto: true,
        };
      } else {
        copy = {
          title: 'This event needs a photo',
          body: 'Take the photo above, then check in.',
        };
      }
      showFormMessage(copy);
      setSubmitting(false);
      return;
    }

    const result = await rpc(
      'submit_checkin',
      {
        p_token: state.token,
        p_member_id: identity.p_member_id ?? null,
        p_claimed_name: identity.p_claimed_name ?? null,
        p_claimed_email: identity.p_claimed_email ?? null,
        p_value: value.value,
        p_evidence: state.evidence,
        p_client_nonce: state.nonce,
      },
      {
        // A matched member cannot double-file: one_live_record_per_member_event
        // refuses the second row and PDS05 is handled below as "already checked
        // in". The unmatched path has no such index behind it, so a retry after
        // a request we never heard back from can leave two claimed-name rows in
        // the queue. Fewer transport retries there, because an officer merging
        // two identical rows is a small cost and losing the check-in entirely
        // is not.
        attempts: identity.p_member_id ? 4 : 3,
        onRetry: ({ reason }) => {
          el.submitLabel.textContent = reason === 'busy' ? 'Waiting…' : 'Reconnecting…';
          announce(RETRY_NOTE[reason]);
        },
      },
    );

    clearEvidence();
    const who = firstName(state.member?.display_name ?? state.claimed?.name ?? '');
    const flags = result?.flags ?? [];
    showDone(who ? `Thanks, ${who}. Submitted for review.` : 'Submitted for review.', [
      flags.includes('unmatched_name')
        ? 'An officer will match your name to the roster before your credit appears.'
        : 'An officer approves check-ins after the event.',
      flags.includes('outside_window') ? 'Late check-in. An officer will review it.' : null,
    ]);
  } catch (err) {
    const copy = describe(err, 'submit');
    if (copy.alreadyDone) {
      clearEvidence();
      showDone(copy.title, [copy.body]);
      return;
    }
    if (copy.retakePhoto) clearEvidence();
    if (copy.retakePhoto) {
      el.photoPreview.hidden = true;
      el.photoRetake.hidden = true;
      setPhotoStatus('error', 'Take the photo again.');
    }
    showFormMessage(copy);
  } finally {
    if (state.submitting) setSubmitting(false);
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function cacheElements() {
  Object.assign(el, {
    viewloading: $('view-loading'),
    viewblocked: $('view-blocked'),
    viewform: $('view-form'),
    viewdone: $('view-done'),
    loadingNote: $('loading-note'),
    blockedTitle: $('blocked-title'),
    blockedBody: $('blocked-body'),
    blockedRetry: $('blocked-retry'),
    eventTitle: $('event-title'),
    eventMeta: $('event-meta'),
    eventCloses: $('event-closes'),
    searchBlock: $('search-block'),
    nameInput: $('name-input'),
    results: $('results'),
    resultsHint: $('results-hint'),
    noNameButton: $('no-name-button'),
    chosenBlock: $('chosen-block'),
    chosenName: $('chosen-name'),
    changeName: $('change-name'),
    claimedBlock: $('claimed-block'),
    claimedName: $('claimed-name'),
    claimedEmail: $('claimed-email'),
    claimedBack: $('claimed-back'),
    valueBlock: $('value-block'),
    valueLabel: $('value-label'),
    valueInput: $('value-input'),
    photoBlock: $('photo-block'),
    photoPrompt: $('photo-prompt'),
    photoOptional: $('photo-optional'),
    photoInput: $('photo-input'),
    photoTakeLabel: $('photo-take-label'),
    photoPreview: $('photo-preview'),
    photoStatus: $('photo-status'),
    photoRetake: $('photo-retake'),
    formMessage: $('form-message'),
    formMessageTitle: $('form-message-title'),
    formMessageBody: $('form-message-body'),
    formMessageRetake: $('form-message-retake'),
    formMessageSkip: $('form-message-skip'),
    submitButton: $('submit-button'),
    submitLabel: $('submit-label'),
    doneTitle: $('done-title'),
    doneBody: $('done-body'),
    live: $('live'),
  });
}

function wire() {
  el.nameInput.addEventListener('input', onSearchInput);
  el.nameInput.addEventListener('keydown', onSearchKeydown);
  el.noNameButton.addEventListener('click', openClaimedForm);
  el.changeName.addEventListener('click', backToSearch);
  el.claimedBack.addEventListener('click', backToSearch);
  el.photoInput.addEventListener('change', onPhotoChosen);
  el.photoRetake.addEventListener('click', () => el.photoInput.click());
  el.formMessageRetake.addEventListener('click', () => el.photoInput.click());
  el.formMessageSkip.addEventListener('click', () => {
    state.allowMissingPhoto = true;
    showFormMessage(null);
    el.submitButton.click();
  });
  el.viewform.addEventListener('submit', onSubmit);
}

export function start() {
  cacheElements();
  wire();

  state.token = new URLSearchParams(window.location.search).get('e');
  if (!state.token) {
    showBlocked(NO_TOKEN);
    return;
  }
  if (!IS_CONFIGURED) {
    showBlocked(NOT_CONFIGURED);
    return;
  }

  restoreEvidence();
  renderResultsHint('Type at least three letters of your name.');
  loadContext();
}
