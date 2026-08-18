// Supabase connection details for the anonymous check-in page.
//
// BOTH VALUES BELOW ARE PUBLIC BY DESIGN. The anon key identifies the project
// and nothing else: it carries no privileges of its own, every table is behind
// RLS, and this page never touches a table. It calls four SECURITY DEFINER
// RPCs, which is what decides what an anonymous caller may do. Committing the
// real values here is therefore correct, and is the only way a static page on
// GitHub Pages can reach the project at all.
//
// Where an officer finds them: Supabase dashboard, Project Settings, API.
// "Project URL" and the "anon" / "public" key. See web/README.md.
//
// NEVER put the service_role key in this file, or in any file under web/.

// Automated tests in Node set this before importing anything, so api.js can be
// pointed at the local mock without editing the file an officer has to fill
// in. In a browser it is always undefined, and the values below are what ship.
const override = globalThis.__PDSA_CONFIG__ ?? {};

export const SUPABASE_URL = override.SUPABASE_URL ?? 'https://psvodlthrxeimlezvmlq.supabase.co';
export const SUPABASE_ANON_KEY =
  override.SUPABASE_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBzdm9kbHRocnhlaW1sZXp2bWxxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY0ODQzNDAsImV4cCI6MjEwMjA2MDM0MH0.yHNQPbTSD-ENgcutpXSH8WaoaIO2ul8pq_80LWUMXNE';

// The account the officer passcode signs in to.
//
// PUBLIC, like everything else in this file, and it is not a secret: it is a
// username. The passcode is the secret, it is never in this repository, and it
// lives as a bcrypt hash in auth.users. Nothing is ever sent to this address.
// See docs/06-officer-passcode.md for how it is set and rotated.
export const OFFICER_ACCOUNT_EMAIL = override.OFFICER_ACCOUNT_EMAIL ?? 'officers@pdsaucf.com';

// The bucket the evidence photos go to. Matches supabase/migrations/…_storage.sql.
export const EVIDENCE_BUCKET = 'evidence';

// True once the placeholders above have been replaced. The page uses this to
// show an honest "not configured yet" message rather than a confusing network
// error.
export const IS_CONFIGURED =
  !SUPABASE_URL.includes('YOUR-PROJECT-REF') &&
  !SUPABASE_ANON_KEY.includes('YOUR-ANON-PUBLIC-KEY');
