// The public events page: /events.
//
// Anyone can open it and read what is coming up. Since migration 30 it is
// also where people sign up: the form opens inside the event's card, a sign-up
// holds a spot at once, and the confirmation email goes out at the time the
// officer chose (docs/09-event-signups.md). The link in that email opens this
// same page with ?signup=<token>, where the person confirms or cancels.
//
// INVARIANT 3 HOLDS HERE EXACTLY AS IT DOES FOR /me AND /c. This page calls
// SECURITY DEFINER functions only (portal_events, portal_member_names,
// portal_signup_submit and the three portal_signup link functions) and
// touches no table. It sends the anon key and never a session.
//
// WHAT IS SHARED WITH THE OTHER SCREENS
//
//   src/api.js            the anonymous request path, with the retry budgets
//                          and the per-attempt timeout. Same one /me and /c use.
//   src/ui.js              the DOM helpers, including announce().
//   src/events-model.js    todayInNewYork(), so "Today" is computed the same
//                          way the admin event list computes it.
//   src/portal-record.js   easternTime(), so a time reads the same way it
//                          does on a member's own attendance record.
//   src/signup-email.js    the long date and confirm-by wording the email uses.

import { IS_CONFIGURED } from '../config.js';
import { rpc } from './api.js';
import { RpcError, NetworkError } from './errors.js';
import { todayInNewYork } from './events-model.js';
import { easternTime } from './portal-record.js';
import { confirmByLabel, longDate } from './signup-email.js';
import { normaliseName } from './match.js';
import { $, h, announce, setHidden } from './ui.js';

const JOIN_URL = 'https://pdsaucf.com';
// The New ribbon stays up for a week after an event is released.
const NEW_FOR_MS = 7 * 24 * 60 * 60 * 1000;

const el = {};

function cacheElements() {
  Object.assign(el, {
    message: $('screen-message'),
    messageTitle: $('screen-message-title'),
    messageBody: $('screen-message-body'),
    messageAction: $('screen-message-action'),
    loading: $('loading'),
    empty: $('empty'),
    groups: $('event-groups'),
    link: $('signup-link'),
  });
}

// ---------------------------------------------------------------------------
// The message strip
// ---------------------------------------------------------------------------

function clearMessage() {
  setHidden(el.message, true);
  el.messageTitle.textContent = '';
  el.messageBody.textContent = '';
  setHidden(el.messageAction, true);
  el.messageAction.onclick = null;
}

/**
 * Turns anything thrown by api.js into copy for this page: a heading, and a
 * line saying what to do.
 */
function describeError(err) {
  if (err instanceof NetworkError) return { title: 'No connection', body: 'Try again once you have signal' };
  if (err instanceof RpcError) {
    switch (err.code) {
      case 'PDS09':
        return { title: 'Too many sign-ups at once', body: 'Wait a minute, then try again' };
      case 'PDS17':
        return { title: 'Members only', body: 'Name not on this years roster', join: true };
      case 'PDS18':
        return { title: 'Already signed up', body: 'The confirmation email has the link to change it' };
      case 'PDS19':
        return { title: 'Sign-ups closed', body: '' };
      case 'PDS20':
        return { title: 'No email on file', body: 'Ask an officer to add your email to the roster' };
      case 'PDS21':
        return err.message.includes('window')
          ? { title: 'Confirmation window passed', body: 'Sign up again if spots are open' }
          : { title: 'Link not valid', body: 'Use the newest email, or sign up again' };
      case 'PDS03':
        return { title: 'Not sent', body: err.message || 'Check the form' };
      default:
        if (err.status >= 500) return { title: 'Not responding', body: 'Wait a few seconds, then try again' };
    }
  }
  return { title: 'Something went wrong', body: 'Try again' };
}

function fail(err) {
  const copy = describeError(err);
  el.messageTitle.textContent = copy.title === 'Something went wrong' ? 'Could not load events' : copy.title;
  el.messageBody.textContent = copy.body;
  el.messageAction.textContent = 'Try again';
  el.messageAction.onclick = () => {
    clearMessage();
    load();
  };
  setHidden(el.messageAction, false);
  setHidden(el.message, false);
  announce(`${copy.title}, ${copy.body}`);
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

/** A value parses as a link only when it is an actual http(s) URL. */
function isHttpUrl(value) {
  if (!value) return false;
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

const factRow = (label, value) => h('div', {}, h('dt', {}, label), h('dd', {}, value));

/**
 * 'GBMs 2, Volunteering Varies', named category by category so nothing here
 * ever prints a total: an event with one from_submission category has no
 * fixed figure to sum, and "0" would read as a promise this page cannot make.
 */
function pointsLabel(categories) {
  if (!categories?.length) return null;
  return categories
    .map((category) => {
      const value =
        category.credit_mode === 'from_submission' ? 'Varies' : String(Number(category.fixed_credit ?? 0));
      return `${category.name} ${value}`;
    })
    .join(', ');
}

const timeLine = (event) =>
  event.starts_at && event.ends_at ? `${easternTime(event.starts_at)} to ${easternTime(event.ends_at)}` : null;

function lockIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', 'M8 1a3.5 3.5 0 0 0-3.5 3.5V6H4a1.5 1.5 0 0 0-1.5 1.5v6A1.5 1.5 0 0 0 4 15h8a1.5 1.5 0 0 0 1.5-1.5v-6A1.5 1.5 0 0 0 12 6h-.5V4.5A3.5 3.5 0 0 0 8 1Zm2 5H6V4.5a2 2 0 1 1 4 0V6Z');
  svg.append(path);
  return svg;
}

/** 'Going' or 'Waitlist 3', as a pill. */
function statePill(state, position) {
  const label = {
    going: 'Going',
    waitlist: `Waitlist ${position ?? ''}`.trim(),
    dropped: 'Dropped',
    cancelled: 'Cancelled',
  }[state] ?? state;
  return h('span', { class: 'signup-pill', dataset: { state } }, label);
}

/** What the card says about spots, or null when there is nothing to say. */
function spotsLabel(signups) {
  if (!signups.open) return 'Sign-ups closed';
  if (signups.capacity) {
    const left = signups.capacity - signups.going;
    if (left > 0) return `${left} of ${signups.capacity} spots left`;
    return signups.waitlist ? `Full, ${signups.waitlist} on waitlist` : 'Full, waitlist open';
  }
  return signups.going ? `${signups.going} going` : null;
}

const isFull = (signups) => Boolean(signups.capacity) && signups.going >= signups.capacity;

/**
 * An open event with no spot limit is a headcount: anyone can come, and the
 * button must not suggest otherwise. Limited spots, or members only, is a
 * real sign-up.
 */
const isHeadcount = (event) => !event.members_only && !event.signups.capacity;

function actionLabel(event) {
  if (isFull(event.signups)) return 'Join waitlist';
  return isHeadcount(event) ? 'Add to headcount' : 'Sign up';
}

/**
 * 'Confirmation email Monday, October 5, 9:00 AM, 2 days before, to the
 * paid-member email on file'. Said beside the name, so whoever picks a name
 * knows where the link goes and when.
 *
 * @param {'member'|'guest'|null} who
 */
function emailNote(event, who) {
  const signups = event.signups;
  const at = signups.email_at ? new Date(signups.email_at) : null;
  const days = Number(signups.email_days_before ?? 0);
  const before = days === 0 ? 'the day of the event' : `${days} day${days === 1 ? '' : 's'} before`;
  const when = at && at > new Date()
    ? `Confirmation email ${confirmByLabel(at)}, ${before}`
    : 'Confirmation email within 5 minutes of signing up';
  let to = '';
  if (who === 'member' || (who === null && event.members_only)) {
    to = event.members_only ? ', to the paid-member email on file' : ', to the email on file';
  } else if (who === 'guest') {
    to = ', to the email entered';
  }
  return `${when}${to}`;
}

// ---------------------------------------------------------------------------
// The roster, for the name autocomplete
// ---------------------------------------------------------------------------

let rosterRequest = null;

/** This year's active roster, read once, the first time a form opens. */
function roster() {
  rosterRequest ??= rpc('portal_member_names', {}).then(
    (rows) => (Array.isArray(rows) ? rows : []),
    (err) => {
      rosterRequest = null;
      throw err;
    },
  );
  return rosterRequest;
}

/** Names starting with what was typed, by any word, first name first. */
function matchNames(names, typed) {
  const key = normaliseName(typed);
  if (!key) return [];
  const starts = (name) => {
    const words = normaliseName(name);
    return words.startsWith(key) || words.split(' ').some((word) => word.startsWith(key));
  };
  return names.filter((row) => starts(row.display_name)).slice(0, 6);
}

// ---------------------------------------------------------------------------
// One event card
// ---------------------------------------------------------------------------

// What each card's form is doing, by event id, so a redraw keeps it.
const forms = new Map();

function eventCard(event) {
  const facts = [];
  if (event.location) facts.push(factRow('Location', event.location));
  if (event.attire) facts.push(factRow('Attire', event.attire));
  const points = pointsLabel(event.categories);
  if (points) facts.push(factRow('Points', points));
  // A non-URL sign-up is a fact like any other; a URL becomes its own button
  // below instead, so it is never printed twice.
  if (event.signup && !isHttpUrl(event.signup)) facts.push(factRow('Sign up', event.signup));

  const released = event.released_at ? new Date(event.released_at).getTime() : null;
  const isNew = released !== null && Date.now() - released < NEW_FOR_MS;
  const time = timeLine(event);

  const card = h(
    'article',
    {
      id: `event-${event.id}`,
      class: 'event-card',
      dataset: { new: String(isNew), membersOnly: String(Boolean(event.members_only)) },
      'aria-labelledby': `event-${event.id}-title`,
    },
    isNew ? h('span', { class: 'event-ribbon' }, h('span', {}, 'New')) : null,
    event.members_only
      ? h('p', { class: 'event-members-badge' }, lockIcon(), 'Members only')
      : h('p', { class: 'event-open-badge' }, 'Open to all'),
    h('h3', { id: `event-${event.id}-title`, class: 'event-card-title' }, event.title),
    time ? h('p', { class: 'event-card-time' }, time) : null,
    facts.length ? h('dl', { class: 'event-card-facts' }, ...facts) : null,
    event.description ? h('p', { class: 'event-card-description' }, event.description) : null,
  );

  if (event.signups) {
    card.append(signupArea(event));
  } else if (isHttpUrl(event.signup)) {
    card.append(
      h(
        'a',
        {
          class: 'button button-primary event-card-signup',
          href: event.signup,
          target: '_blank',
          rel: 'noopener noreferrer',
        },
        'Sign up',
      ),
    );
  }
  return card;
}

function signupArea(event) {
  const area = h('div', { class: 'signup-area', id: `signup-${event.id}` });
  drawSignupArea(area, event);
  return area;
}

function drawSignupArea(area, event) {
  const signups = event.signups;
  const form = forms.get(event.id) ?? { stage: 'closed' };
  const spots = spotsLabel(signups);
  const children = [];

  if (spots) {
    children.push(h('p', { class: 'event-card-spots', dataset: { full: String(isFull(signups)), closed: String(!signups.open) } }, spots));
  }

  if (form.stage === 'done') {
    children.push(doneBlock(form.result, isHeadcount(event)));
  } else if (form.stage === 'open') {
    children.push(signupForm(area, event, form));
  } else if (signups.open) {
    children.push(
      h(
        'button',
        {
          type: 'button',
          class: 'button button-primary event-card-signup',
          'aria-expanded': 'false',
          onClick: () => {
            forms.set(event.id, { stage: 'open', member: null, name: '', email: '', answers: {}, error: null });
            drawSignupArea(area, event);
            area.querySelector('input')?.focus();
          },
        },
        actionLabel(event),
      ),
    );
  }
  area.replaceChildren(...children);
}

/** The confirmation of a sign-up just made, in place of the form. */
function doneBlock(result, headcount) {
  const email = result.email_at && new Date(result.email_at) > new Date()
    ? `Confirmation email ${confirmByLabel(result.email_at)}`
    : 'Confirmation email within 5 minutes';
  return h(
    'div',
    { class: 'signup-done', role: 'status' },
    h('p', { class: 'signup-done-head' }, statePill(result.state, result.waitlist_position),
      h('span', {}, headcount ? 'Added to headcount' : 'Signed up')),
    h('p', { class: 'signup-done-line' }, `${email}, to ${result.is_member ? 'the address on file' : 'the address entered'}`),
    h('p', { class: 'muted small' }, `Confirm within ${result.confirm_hours} hours of the email to keep the spot`),
  );
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

function membersOnlyBlock() {
  return h(
    'div',
    { class: 'signup-members-only', role: 'status' },
    h('p', { class: 'signup-members-only-title' }, lockIcon(), 'Members only'),
    h('p', { class: 'small' }, 'Name not on this years roster'),
    h('a', { class: 'button button-secondary', href: JOIN_URL, target: '_blank', rel: 'noopener noreferrer' }, 'Become a member'),
  );
}

let fieldSeq = 0;
const fieldId = (name) => {
  fieldSeq += 1;
  return `f-${name}-${fieldSeq}`;
};

function signupForm(area, event, form) {
  const signups = event.signups;
  const redraw = () => drawSignupArea(area, event);
  const node = h('form', { class: 'signup-form', novalidate: true });

  // -- who ----------------------------------------------------------------
  const nameId = fieldId('name');
  const listId = fieldId('names');
  const who = h('div', { class: 'signup-field' });

  if (form.member) {
    who.append(
      h('span', { class: 'label' }, 'Name'),
      h(
        'div',
        { class: 'signup-picked' },
        h('span', { class: 'signup-picked-name' }, form.member.display_name),
        h('span', { class: 'signup-tag' }, 'Member'),
        h('button', {
          type: 'button',
          class: 'link-button',
          onClick: () => {
            form.member = null;
            form.name = '';
            redraw();
            area.querySelector(`#${CSS.escape(nameId)}`)?.focus();
          },
        }, 'Change'),
      ),
      h('p', { class: 'signup-email-note' }, emailNote(event, 'member')),
    );
  } else {
    const input = h('input', {
      id: nameId,
      class: 'input',
      type: 'text',
      autocomplete: 'off',
      autocapitalize: 'words',
      spellcheck: false,
      role: 'combobox',
      'aria-autocomplete': 'list',
      'aria-expanded': 'false',
      'aria-controls': listId,
      value: form.name,
    });
    const list = h('ul', { id: listId, class: 'signup-names', role: 'listbox', hidden: true });
    const guestBlock = h('div', { class: 'signup-guest' });
    const note = h('p', { class: 'signup-email-note' }, emailNote(event, null));
    input.setAttribute('aria-describedby', `${nameId}-note`);
    note.id = `${nameId}-note`;
    who.append(h('label', { class: 'label', for: nameId }, 'Full name'), input, note, list, guestBlock);

    let active = -1;
    let shown = [];
    const pick = (row) => {
      form.member = row;
      form.name = row.display_name;
      redraw();
    };
    const drawList = (names) => {
      shown = matchNames(names, input.value);
      active = -1;
      list.replaceChildren(
        ...shown.map((row, index) =>
          h(
            'li',
            {
              id: `${listId}-${index}`,
              role: 'option',
              class: 'signup-name-option',
              'aria-selected': 'false',
            },
            row.display_name,
          )),
      );
      list.querySelectorAll('li').forEach((li, index) => {
        // mousedown, so the pick lands before the input loses focus.
        li.addEventListener('mousedown', (down) => {
          down.preventDefault();
          pick(shown[index]);
        });
      });
      const open = shown.length > 0 && input.value.trim().length > 0;
      setHidden(list, !open);
      input.setAttribute('aria-expanded', String(open));
      input.removeAttribute('aria-activedescendant');
      drawGuest(names);
    };
    // Nobody on the roster by this name: the guest fields on an open event,
    // the members-only block on a members-only one.
    const drawGuest = (names) => {
      const typed = input.value.trim();
      const noMatch = typed.length >= 2 && matchNames(names, typed).length === 0;
      node.dataset.blocked = 'false';
      note.textContent = emailNote(event, noMatch && !event.members_only ? 'guest' : null);
      if (!noMatch) {
        guestBlock.replaceChildren();
        return;
      }
      if (event.members_only) {
        // Shown once a whole name is typed, not on the first letters.
        const wholeName = typed.split(/\s+/).length >= 2;
        guestBlock.replaceChildren(...(wholeName ? [membersOnlyBlock()] : []));
        node.dataset.blocked = String(wholeName);
        return;
      }
      const emailId = fieldId('email');
      guestBlock.replaceChildren(
        h('p', { class: 'small' }, 'Not on the roster, signing up as a guest'),
        h('label', { class: 'label', for: emailId }, 'Email'),
        h('input', {
          id: emailId,
          class: 'input',
          type: 'email',
          autocomplete: 'email',
          value: form.email,
          onInput: (change) => {
            form.email = change.target.value;
          },
        }),
      );
    };

    const setActive = (next) => {
      const items = list.querySelectorAll('li');
      if (!items.length) return;
      active = (next + items.length) % items.length;
      items.forEach((li, index) => li.setAttribute('aria-selected', String(index === active)));
      input.setAttribute('aria-activedescendant', items[active].id);
    };

    input.addEventListener('input', async () => {
      form.name = input.value;
      try {
        drawList(await roster());
      } catch {
        // Without the roster nobody can be matched; the server still decides.
        drawList([]);
      }
    });
    input.addEventListener('keydown', (key) => {
      if (key.key === 'ArrowDown') {
        key.preventDefault();
        setActive(active + 1);
      } else if (key.key === 'ArrowUp') {
        key.preventDefault();
        setActive(active - 1);
      } else if (key.key === 'Enter' && active >= 0 && shown[active]) {
        key.preventDefault();
        pick(shown[active]);
      } else if (key.key === 'Escape') {
        setHidden(list, true);
        input.setAttribute('aria-expanded', 'false');
      }
    });
    input.addEventListener('blur', () => {
      setHidden(list, true);
      input.setAttribute('aria-expanded', 'false');
    });
    // A form reopened after an error keeps what was typed.
    if (form.name) roster().then(drawGuest, () => drawGuest([]));
  }
  node.append(who);

  // -- the questions --------------------------------------------------------
  for (const question of signups.questions ?? []) {
    node.append(questionField(question, form));
  }
  // The questions sit after the name, and hide while the name is one that
  // cannot sign up here.

  // -- send -----------------------------------------------------------------
  if (form.error) {
    const errorBox = (
      h(
        'div',
        { class: 'signup-error', role: 'alert' },
        h('p', { class: 'signup-error-title' }, form.error.title),
        form.error.body ? h('p', { class: 'small' }, form.error.body) : null,
        form.error.join
          ? h('a', { class: 'button button-secondary', href: JOIN_URL, target: '_blank', rel: 'noopener noreferrer' }, 'Become a member')
          : null,
      )
    );
    node.append(errorBox);
  }
  const submit = h('button', { type: 'submit', class: 'button button-primary signup-submit' }, actionLabel(event));
  node.append(
    h(
      'div',
      { class: 'signup-actions' },
      submit,
      h('button', {
        type: 'button',
        class: 'button button-secondary',
        onClick: () => {
          forms.delete(event.id);
          redraw();
        },
      }, 'Cancel'),
    ),
  );

  node.addEventListener('submit', async (sent) => {
    sent.preventDefault();
    if (form.busy) return;
    form.error = null;

    let member = form.member;
    if (!member && form.name.trim()) {
      // A whole name typed without picking from the list still counts.
      try {
        const exact = (await roster()).filter((row) => normaliseName(row.display_name) === normaliseName(form.name));
        if (exact.length === 1) member = exact[0];
      } catch {
        // The server decides below.
      }
    }
    if (!member && !form.name.trim()) {
      form.error = { title: 'Type your full name', body: '' };
      redraw();
      return;
    }
    if (!member && event.members_only) {
      form.error = { title: 'Members only', body: 'Name not on this years roster', join: true };
      redraw();
      return;
    }

    form.busy = true;
    submit.disabled = true;
    submit.textContent = 'Signing up';
    try {
      const result = await rpc('portal_signup_submit', {
        p_event_id: event.id,
        p_member_id: member?.member_id ?? null,
        p_name: member ? null : form.name.trim(),
        p_email: member ? null : form.email.trim() || null,
        p_answers: form.answers,
      }, { attempts: 1 });
      forms.set(event.id, { stage: 'done', result });
      // The counts on the card moved too.
      if (result.state === 'going') event.signups.going += 1;
      else if (result.state === 'waitlist') event.signups.waitlist += 1;
      announce(`${isHeadcount(event) ? 'Added to headcount' : 'Signed up'}, ${result.state === 'going' ? 'going' : `waitlist ${result.waitlist_position}`}`);
    } catch (err) {
      form.error = describeError(err);
      form.busy = false;
    }
    redraw();
    area.querySelector('.signup-error, .signup-done')?.scrollIntoView({ block: 'nearest' });
  });

  return node;
}

function questionField(question, form) {
  const id = fieldId('q');
  const optional = question.required ? null : h('span', { class: 'signup-optional' }, 'Optional');

  if (question.kind === 'single_choice' || question.kind === 'multi_choice') {
    const multi = question.kind === 'multi_choice';
    const name = fieldId('choice');
    const chosen = () => form.answers[question.id] ?? (multi ? [] : '');
    return h(
      'fieldset',
      { class: 'signup-field signup-choices' },
      h('legend', { class: 'label' }, question.prompt, optional),
      ...question.options.map((option) =>
        h(
          'label',
          { class: 'signup-choice' },
          h('input', {
            type: multi ? 'checkbox' : 'radio',
            name,
            value: option,
            checked: multi ? chosen().includes(option) : chosen() === option,
            onChange: (change) => {
              if (multi) {
                const set = new Set(chosen());
                if (change.target.checked) set.add(option);
                else set.delete(option);
                form.answers[question.id] = question.options.filter((o) => set.has(o));
              } else {
                form.answers[question.id] = option;
              }
            },
          }),
          h('span', {}, option),
        )),
    );
  }

  const long = question.kind === 'long_text';
  return h(
    'div',
    { class: 'signup-field' },
    h('label', { class: 'label', for: id }, question.prompt, optional),
    h(long ? 'textarea' : 'input', {
      id,
      class: 'input',
      ...(long ? { rows: '3' } : { type: 'text' }),
      maxlength: long ? '4000' : '500',
      value: form.answers[question.id] ?? '',
      onInput: (change) => {
        form.answers[question.id] = change.target.value;
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// The link in the email: ?signup=<token>
// ---------------------------------------------------------------------------

async function showSignupLink(token) {
  setHidden(el.link, false);
  el.link.replaceChildren(h('p', { class: 'spinner', 'aria-hidden': 'true' }));
  try {
    drawSignupLink(token, await rpc('portal_signup', { p_token: token }));
  } catch (err) {
    drawSignupLinkError(err);
  }
}

function drawSignupLinkError(err) {
  const copy = describeError(err);
  el.link.replaceChildren(
    h(
      'div',
      { class: 'signup-link-card', role: 'alert' },
      h('h2', { class: 'signup-link-title' }, copy.title),
      copy.body ? h('p', { class: 'muted' }, copy.body) : null,
    ),
  );
}

function drawSignupLink(token, view, { askingCancel = false } = {}) {
  const event = view.event;
  const live = view.state === 'going' || view.state === 'waitlist';
  const time = timeLine(event);
  const act = async (call, said) => {
    try {
      const next = await call();
      drawSignupLink(token, next);
      announce(said);
    } catch (err) {
      drawSignupLinkError(err);
    }
  };

  const actions = [];
  if (live && view.reply === 'awaiting' && !event.past) {
    actions.push(
      h('button', {
        type: 'button',
        class: 'button button-primary signup-link-confirm',
        onClick: (click) => {
          click.currentTarget.disabled = true;
          act(() => rpc('portal_signup_confirm', { p_token: token }, { attempts: 1 }), 'Spot confirmed');
        },
      }, 'Confirm spot'),
    );
  }
  if (live && !event.past) {
    if (askingCancel) {
      actions.push(
        h(
          'div',
          { class: 'signup-link-cancel', role: 'group', 'aria-label': 'Cancel sign-up' },
          h('p', { class: 'small' }, 'Cancel sign-up and give up the spot?'),
          h('div', { class: 'signup-actions' },
            h('button', {
              type: 'button',
              class: 'button button-danger',
              onClick: () => act(() => rpc('portal_signup_cancel', { p_token: token }, { attempts: 1 }), 'Sign-up cancelled'),
            }, 'Cancel sign-up'),
            h('button', {
              type: 'button',
              class: 'button button-secondary',
              onClick: () => drawSignupLink(token, view),
            }, 'Keep spot')),
        ),
      );
    } else {
      actions.push(
        h('button', {
          type: 'button',
          class: 'link-button',
          onClick: () => drawSignupLink(token, view, { askingCancel: true }),
        }, 'Cancel sign-up'),
      );
    }
  }

  let replyLine = null;
  if (live && view.reply === 'confirmed') replyLine = h('p', { class: 'signup-link-reply', dataset: { reply: 'confirmed' } }, 'Confirmed');
  else if (live && view.reply === 'awaiting') {
    replyLine = h('p', { class: 'signup-link-reply' }, `Confirm by ${confirmByLabel(view.confirm_by)}`);
  }

  el.link.replaceChildren(
    h(
      'div',
      { class: 'signup-link-card' },
      h('h2', { class: 'signup-link-title' }, event.title),
      h('p', { class: 'event-card-time' }, [longDate(event.occurred_on), time].filter(Boolean).join(', ')),
      event.location ? h('p', { class: 'muted' }, event.location) : null,
      h('p', { class: 'signup-link-who' }, h('span', {}, view.name), statePill(view.state, view.waitlist_position)),
      replyLine,
      ...actions,
    ),
  );
}

// ---------------------------------------------------------------------------
// Grouping by date
// ---------------------------------------------------------------------------

const weekdayFormatter = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  month: 'short',
  day: 'numeric',
});

/** 'Today', or 'Thursday, Sep 10' for occurred_on ('YYYY-MM-DD'), parsed by parts. */
function dateHeadingLabel(occurredOn, today) {
  if (occurredOn === today) return 'Today';
  const [y, m, d] = String(occurredOn).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return String(occurredOn);
  return weekdayFormatter.format(new Date(y, m - 1, d));
}

/**
 * portal_events() already returns events ascending by date, so grouping
 * consecutive rows sharing one occurred_on is enough: nothing here re-sorts.
 */
function groupByDate(events) {
  const groups = [];
  for (const event of events) {
    const date = String(event.occurred_on).slice(0, 10);
    const current = groups.at(-1);
    if (!current || current.date !== date) groups.push({ date, events: [event] });
    else current.events.push(event);
  }
  return groups;
}

function renderGroups(events) {
  const today = todayInNewYork();
  el.groups.replaceChildren(
    ...groupByDate(events).map((group) =>
      h(
        'section',
        { class: 'event-date-group' },
        h(
          'h2',
          { class: 'event-date-heading', dataset: { today: String(group.date === today) } },
          dateHeadingLabel(group.date, today),
        ),
        h('div', { class: 'event-cards' }, ...group.events.map(eventCard)),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function load() {
  clearMessage();
  setHidden(el.loading, false);
  setHidden(el.empty, true);
  setHidden(el.groups, true);
  try {
    const answer = await rpc('portal_events', {});
    const events = Array.isArray(answer?.events) ? answer.events : [];
    setHidden(el.loading, true);
    if (!events.length) {
      setHidden(el.empty, false);
      return;
    }
    renderGroups(events);
    setHidden(el.groups, false);
    // A link from the Member Calendar names one event.
    const hash = globalThis.location?.hash ?? '';
    if (hash.startsWith('#event-')) {
      document.getElementById(hash.slice(1))?.scrollIntoView?.({ block: 'start' });
    }
  } catch (err) {
    setHidden(el.loading, true);
    fail(err);
  }
}

// ---------------------------------------------------------------------------

export function start() {
  cacheElements();
  $('footer-year').textContent = new Date().getFullYear();

  if (!IS_CONFIGURED) {
    el.messageTitle.textContent = 'This page is not connected yet';
    el.messageBody.textContent = 'Ask an officer';
    setHidden(el.messageAction, true);
    setHidden(el.message, false);
    setHidden(el.loading, true);
    return;
  }

  const token = new URLSearchParams(globalThis.location?.search ?? '').get('signup');
  if (token) showSignupLink(token);
  load();
}
