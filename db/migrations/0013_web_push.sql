-- Web push: the two keys a browser subscription carries, beside the endpoint.
--
-- ## Why this is one column and not a new table
--
-- Because a browser subscription *is* a device, and `devices` already models
-- one correctly. A subscription has three parts:
--
--   endpoint   a URL at Apple, Google or Mozilla that identifies this browser
--   p256dh     the browser's public key
--   auth       a shared secret
--
-- The endpoint is exactly what `push_token` already means — the address the
-- server sends to — so it goes there and inherits the property that column
-- already enforces: `devices_push_token_key` is unique, so re-subscribing on a
-- shared computer *moves* the subscription to the new account rather than
-- leaving two accounts pointed at one browser. That is the same rule a phone's
-- FCM token follows, and getting it for free is the argument for not inventing
-- a second table.
--
-- What has nowhere to live is the pair of keys. They are meaningless without
-- the endpoint, always written and read together, and never queried on their
-- own — which is a JSON value, not two columns.
--
-- ## Why it is nullable
--
-- Every existing row is a phone registered through the native app, where the
-- token needs no keys at all. `NULL` means "not a web subscription", and the
-- transport that sends to it is chosen by `platform`, not by this column.
--
-- ## What is not here
--
-- The VAPID keypair the server signs with. That is one keypair for the whole
-- deployment, not per device, and it belongs in the environment beside every
-- other credential — never in a table, and never in this repository.

ALTER TABLE devices ADD COLUMN push_keys jsonb;

COMMENT ON COLUMN devices.push_keys IS
  'Web push only: {"p256dh": "...", "auth": "..."} from the browser''s PushSubscription. Null for native devices, whose push_token needs no keys.';
