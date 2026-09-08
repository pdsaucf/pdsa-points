# Individual leadership access

Implemented locally for review. No production migration or Google provider configuration
has been applied. The member portal and check-in stay anonymous and unchanged.

## Authorization

Leadership approval is separate from members and enrollment. An admin approves an exact
Google account email as `admin` (Secretary) or `officer` (Officer or Director). A successful
Google sign-in without approval gets no staff access. Leadership emails never become member
emails or roster records.

`leadership_session()` binds a pending approval only to its caller's independently verified
Google identity. The database reads `auth.identities` with `provider = 'google'`, a JSON
boolean `email_verified: true`, the provider email, and the stable provider subject. It
ignores browser claims, `auth.users.email` for individual accounts, and editable
`raw_user_meta_data`. Supabase documents OAuth identity data as provider data in
[User identities](https://supabase.com/docs/guides/auth/identities).

The first binding retains both the Auth user id and the Google subject. Another account
with the same email cannot take it over. Changing the provider email or removing/verifying
an identity differently does not silently retarget access. An admin must resolve account
changes deliberately. Revoked rows retain their binding and never reapprove on login.
An explicit new authorization of the same email restores that original binding.

Profiles remain the role lookup source, backed by an active approval whose user, role,
provider subject and verified email still match. Every protected call checks that binding;
revocation or a role change works with an already-issued JWT. Direct profile writes are
revoked even for authenticated admins. A legacy SQL profile without a managed approval
confers no individual role: use the shared admin to approve the intended Google account
and let that person sign in. No legacy profile is automatically trusted or reapproved.

All access mutations and initial binding take the same transaction advisory lock. Changes
recheck admin authorization after locking. A demotion or revocation cannot remove the last
bound, effective individual admin. The shared fallback and pending approvals do not count,
and neither does a bound row whose profile or verified provider identity no longer matches.
With two admins, one can revoke the other; the revoked session cannot then revoke the survivor.
Privileged operator SQL remains a recovery path and must preserve these invariants itself.

Access changes have a separate admin-only audit history. Leadership email addresses never
enter the ordinary staff-readable audit log. The unchanged shared passcode account remains
an admin fallback and can approve the first individual Secretary. Its actions still name
the shared identity; Google-bound accounts provide individual attribution.

Officers may create/edit/duplicate events, delete empty events, publish/unpublish events,
and read the roster and attendance. Attendance, roster, categories, requirements, settings,
photo deletion and leadership management require admin. Officers cannot read evidence
metadata or private storage objects. Existing bearer photo URLs remain valid until expiry;
new image access requires the admin storage policy.

## Frontend RPC contract

All RPCs require an authenticated session. Only `leadership_session()` is callable without
an application role; it returns a null role for unapproved or unverifiable individuals.

| RPC | Result |
| --- | --- |
| `leadership_session()` | JSON: `role`, `is_shared_admin`, `email` |
| `list_leadership_access()` | Rows: `id`, `email`, `role`, `user_id`, `google_subject`, `bound_at`, `revoked_at`, `created_at`, `updated_at` |
| `authorize_leadership_access(p_email text, p_role app_role)` | Access row JSON; new approval or explicit restoration |
| `set_leadership_role(p_access_id uuid, p_role app_role)` | Access row JSON |
| `revoke_leadership_access(p_access_id uuid)` | Access row JSON; repeated revocation is idempotent |
| `list_leadership_audit()` | Rows: `id`, `access_id`, `created_at`, `action`, `actor_email`, `target_email`, `old_role`, `new_role` |

Only `admin` and `officer` are accepted. Email matching trims surrounding whitespace and
ignores case; it does not equate aliases or different addresses. The shared fallback email
cannot be preapproved as an individual. `PDS07` means denied, `PDS03` means invalid input
or missing access, and `PDS16` means the last individual admin would be removed. Audit
actions are `authorize`, `change_role`, `revoke` and `bind`.

## Deployment and Google setup

These are operator steps, not actions performed by this change. Apply the officer-role
and leadership-access migrations before deploying the frontend that calls these RPCs.
Keep the existing shared user and password grant functioning throughout.

1. In Google Cloud, configure an OAuth Web application with JavaScript origin
   `https://points.pdsaucf.com` and authorized redirect URI
   `https://psvodlthrxeimlezvmlq.supabase.co/auth/v1/callback`.
2. Configure the consent screen for the accounts leadership actually uses. Choose Internal
   only if the organization can include every intended account. Otherwise use External
   and add test users while the app is in testing. Request only `openid`, `email`, `profile`.
3. Enable Google in Supabase Authentication and enter the Google client ID and secret
   there. Never put either a client secret or a service-role key into repository files.
4. Allow the app callback `https://points.pdsaucf.com/admin/` in Supabase Auth URL
   configuration. The Google callback and app callback above are different endpoints.
5. Permit new OAuth users so first-time approved leaders can sign in. Keep email signup
   disabled separately if supported, and leave manual identity linking disabled. A newly
   created Auth user still has no staff role until approved and provider-verified.
6. Sign in with the existing shared passcode, approve the first individual Secretary's
   Google email as Admin, and have that person complete Google sign-in. Confirm the
   binding before handing over management. Approve officers with the Officer role.

Official references: [Google login](https://supabase.com/docs/guides/auth/social-login/auth-google)
and [PKCE flow](https://supabase.com/docs/guides/auth/sessions/pkce-flow).

Observed read-only project settings on September 7, 2026: Google disabled, email enabled,
global signup disabled, and email autoconfirm disabled. Those settings need the operator
changes above. Actual Google login has not been verified against the live provider.

## Validation scope

`test/privileges.test.mjs` exercises refused officer and stranger operations, Google-only
binding, forged metadata, unverified identities, stable binding, revocation using the same
JWT, protected leadership audit, pending/stale alternative admins, and last-admin refusal.
The migration suite also relocates `citext` into `extensions` before applying the role
migration with an initially public-only search path.

These tests use PGlite with Supabase Auth/storage stand-ins. PGlite provides one backend,
so it does not prove simultaneous transactions from separate live connections. The shared
advisory lock and checks after locking are covered structurally, alongside sequential
competing-session refusals. Real Google OAuth and live concurrent SQL verification remain
operator validation steps.
