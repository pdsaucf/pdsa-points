-- Sets, or rotates, the officer passcode.
--
-- RUN THIS IN THE SUPABASE DASHBOARD'S SQL EDITOR (Database > SQL Editor).
-- That editor sends whatever you paste straight to Postgres: it is not psql,
-- so it cannot prompt for input, and a `\set` or `\prompt` line is a syntax
-- error there rather than a client command. Below the passcode is a literal
-- you edit in place before running.
--
-- Replace REPLACE_WITH_NEW_PASSCODE, run the query, confirm the result says
-- "passcode set", then CLEAR THE EDITOR AND DO NOT SAVE IT AS A SNIPPET. The
-- passcode is the only secret in this product and this repository is public:
-- a commit that carries it is a commit that publishes it, and this file
-- itself must never hold the real value either, checked in or pasted and
-- forgotten. The dashboard keeps a history of queries run under your
-- account, which is the one place outside a commit the real value can end up
-- sitting after you are done with it.
--
-- What it does: replaces the bcrypt hash on the one shared account named by
-- OFFICER_ACCOUNT_EMAIL in web/config.js. Everyone signed in stays signed in
-- until their refresh token expires, so rotating because somebody left the
-- club means running this AND clearing that account's sessions (the second
-- statement at the bottom, which is the part people forget).
--
-- Creating the account for the first time is a dashboard action, not this
-- script: Authentication > Users > Add user, with the address from
-- config.js, any password, and "Auto Confirm User" ticked. An unconfirmed
-- account cannot use the password grant, and nothing will ever send mail to
-- that address to confirm it. The database authorizes only this fixed Auth
-- address; there is no separate profile or role.
--
-- Without that row the passcode signs in successfully and then reads nothing,
-- which is the guard doing its job rather than a bug.

update auth.users
   set encrypted_password = crypt('REPLACE_WITH_NEW_PASSCODE', gen_salt('bf')),
       updated_at         = now()
 where email = 'officers@pdsaucf.com';

-- Nothing matched means the account does not exist yet: see the dashboard
-- step above. Postgres reports this as UPDATE 0 rather than as an error, and
-- a silent no-op here reads exactly like a successful rotation.
select
  case count(*)
    when 0 then 'NO SUCH ACCOUNT: create it in the dashboard first'
    else 'passcode set'
  end as result
from auth.users
where email = 'officers@pdsaucf.com';

-- Rotating because somebody should no longer have access? Uncomment this. It
-- ends every live session on the shared account, so anybody already signed
-- in has to enter the new passcode. Leaving it commented is right for a
-- routine change of passcode, where signing the whole board out mid-GBM is
-- worse than the risk it removes.
--
-- delete from auth.sessions
--  where user_id = (select id from auth.users where email = 'officers@pdsaucf.com');

-- ---------------------------------------------------------------------------
-- Running this from an actual terminal instead (psql, or `supabase db
-- ...  | psql`)? \set and \prompt work there and mean the passcode is never
-- typed into a browser tab at all:
--
--   \set officer_email 'officers@pdsaucf.com'
--   \prompt 'New passcode: ' passcode
--
--   update auth.users
--      set encrypted_password = crypt(:'passcode', gen_salt('bf')),
--          updated_at         = now()
--    where email = :'officer_email';
--
-- Do not paste that block into the dashboard editor; it is CLI-only, which is
-- the exact mistake this file used to make.
-- ---------------------------------------------------------------------------
