-- Sets, or rotates, the officer passcode.
--
-- RUN THIS FROM THE SUPABASE SQL EDITOR, and paste the passcode in at the
-- prompt below rather than saving it into this file. The passcode is the only
-- secret in this product and this repository is public: a commit that carries
-- it is a commit that publishes it, and rewriting the history afterwards does
-- not un-publish anything that was already cloned or indexed.
--
-- What it does: replaces the bcrypt hash on the one shared account named by
-- OFFICER_ACCOUNT_EMAIL in web/config.js. Everyone signed in stays signed in
-- until their refresh token expires, so rotating because somebody left the club
-- means running this AND clearing that account's sessions (the second statement
-- at the bottom, which is the part people forget).
--
-- Creating the account for the first time is a dashboard action, not this
-- script: Authentication > Users > Add user, with the address from config.js,
-- any password, and "Auto Confirm User" ticked. An unconfirmed account cannot
-- use the password grant, and nothing will ever send mail to that address to
-- confirm it. Then give it a role:
--
--   insert into profiles (user_id, role, full_name)
--   select id, 'admin', null from auth.users where email = 'officers@pdsaucf.com';
--
-- Without that row the passcode signs in successfully and then reads nothing,
-- which is the guard doing its job rather than a bug.

\set officer_email 'officers@pdsaucf.com'
\prompt 'New passcode: ' passcode

update auth.users
   set encrypted_password = crypt(:'passcode', gen_salt('bf')),
       updated_at         = now()
 where email = :'officer_email';

-- Nothing matched means the account does not exist yet: see the dashboard step
-- above. Postgres reports this as UPDATE 0 rather than as an error, and a
-- silent no-op here reads exactly like a successful rotation.
select
  case count(*)
    when 0 then 'NO SUCH ACCOUNT: create it in the dashboard first'
    else 'passcode set'
  end as result
from auth.users
where email = :'officer_email';

-- Rotating because somebody should no longer have access? Uncomment this. It
-- ends every live session on the shared account, so anybody already signed in
-- has to enter the new passcode. Leaving it commented is right for a routine
-- change of passcode, where signing the whole board out mid-GBM is worse than
-- the risk it removes.
--
-- delete from auth.sessions
--  where user_id = (select id from auth.users where email = :'officer_email');
