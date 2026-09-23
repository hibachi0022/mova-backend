#!/usr/bin/env bash

set -euo pipefail

API_BASE="${API_BASE:-http://localhost:4001/api/v1}"

TMP_DIR="$(mktemp -d)"
OUTING_ID=""

cleanup() {
  local original_status=$?

  trap - EXIT
  set +e

  if [[ -n "${OUTING_ID:-}" ]]; then
    echo
    echo "Cleaning up live-test outing..."

    TEST_OUTING_ID="$OUTING_ID" \
    node \
      --env-file=.env \
      --input-type=module \
      <<'NODE'
import {
  createClient,
} from '@supabase/supabase-js';

const url =
  process.env.SUPABASE_URL;

const secret =
  process.env.SUPABASE_SECRET_KEY;

const outingId =
  process.env.TEST_OUTING_ID;

if (
  !url ||
  !secret ||
  !outingId
) {
  process.exit(0);
}

const supabase =
  createClient(
    url,
    secret,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );

const {
  error,
} =
  await supabase
    .from('outings')
    .delete()
    .eq(
      'id',
      outingId,
    );

if (error) {
  console.error(
    `Cleanup warning: ${error.message}`,
  );

  process.exit(0);
}

console.log(
  '✓ Live-test outing removed',
);
NODE
  fi

  rm -rf "$TMP_DIR"

  exit "$original_status"
}

trap cleanup EXIT

json_value() {
  local json_path="$1"

  JSON_PATH="$json_path" \
  node -e '
    const fs = require("fs");

    const input =
      fs.readFileSync(
        0,
        "utf8",
      );

    try {
      const data =
        JSON.parse(input);

      const parts =
        process.env.JSON_PATH
          .split(".");

      let value =
        data;

      for (
        const part of parts
      ) {
        value =
          value?.[part];
      }

      if (
        value === undefined ||
        value === null
      ) {
        process.stdout.write("");
      } else if (
        typeof value === "string"
      ) {
        process.stdout.write(
          value,
        );
      } else {
        process.stdout.write(
          JSON.stringify(
            value,
          ),
        );
      }
    } catch {
      process.stdout.write("");
    }
  '
}

make_login_payload() {
  EMAIL_VALUE="$1" \
  PASSWORD_VALUE="$2" \
  node -e '
    process.stdout.write(
      JSON.stringify({
        email:
          process.env.EMAIL_VALUE,
        password:
          process.env.PASSWORD_VALUE,
      }),
    );
  '
}

login() {
  local email="$1"
  local password="$2"

  local payload

  payload="$(
    make_login_payload \
      "$email" \
      "$password"
  )"

  curl -sS \
    -X POST \
    "$API_BASE/auth/login" \
    -H "Content-Type: application/json" \
    -d "$payload"
}

api_get_status() {
  local token="$1"
  local path="$2"
  local output_file="$3"

  curl -sS \
    -o "$output_file" \
    -w "%{http_code}" \
    "$API_BASE$path" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json"
}

api_post_status() {
  local token="$1"
  local path="$2"
  local body="$3"
  local output_file="$4"

  curl -sS \
    -o "$output_file" \
    -w "%{http_code}" \
    -X POST \
    "$API_BASE$path" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -d "$body"
}

response_has_member() {
  local display_name="$1"
  local opted_in="$2"

  DISPLAY_NAME="$display_name" \
  OPTED_IN="$opted_in" \
  node -e '
    const fs = require("fs");

    const data =
      JSON.parse(
        fs.readFileSync(
          0,
          "utf8",
        ),
      );

    const expected =
      process.env.OPTED_IN ===
        "true";

    const found =
      Array.isArray(
        data.members,
      ) &&
      data.members.some(
        (member) =>
          member.displayName ===
            process.env.DISPLAY_NAME &&
          member.optedIn ===
            expected,
      );

    process.exit(
      found ? 0 : 1,
    );
  '
}

verify_invite_storage() {
  local outing_id="$1"
  local raw_code="$2"

  TEST_OUTING_ID="$outing_id" \
  RAW_INVITE_CODE="$raw_code" \
  node \
    --env-file=.env \
    --input-type=module \
    <<'NODE'
import {
  createHash,
} from 'node:crypto';

import {
  createClient,
} from '@supabase/supabase-js';

const outingId =
  process.env.TEST_OUTING_ID;

const rawCode =
  process.env.RAW_INVITE_CODE;

const expectedHash =
  createHash(
    'sha256',
  )
    .update(
      rawCode.trim().toUpperCase(),
      'utf8',
    )
    .digest('hex');

const supabase =
  createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SECRET_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );

const {
  data,
  error,
} =
  await supabase
    .from(
      'outing_join_codes',
    )
    .select(
      'code_hash, code_hint, revoked_at, use_count, max_uses',
    )
    .eq(
      'outing_id',
      outingId,
    )
    .is(
      'revoked_at',
      null,
    )
    .single();

if (
  error ||
  !data
) {
  console.error(
    'Active invitation row could not be loaded.',
  );

  process.exit(1);
}

if (
  data.code_hash !==
    expectedHash
) {
  console.error(
    'Stored invitation hash does not match the raw invitation.',
  );

  process.exit(1);
}

if (
  data.code_hash ===
    rawCode
) {
  console.error(
    'Raw invitation code was stored instead of a hash.',
  );

  process.exit(1);
}

if (
  data.code_hint !==
    rawCode.slice(-4)
) {
  console.error(
    'Invitation code hint was unexpected.',
  );

  process.exit(1);
}

if (
  JSON.stringify(
    data,
  ).includes(
    `"${rawCode}"`,
  )
) {
  console.error(
    'Raw invitation code appeared in the database row.',
  );

  process.exit(1);
}

console.log(
  '✓ Supabase stores the SHA-256 hash, not the raw invite code',
);
NODE
}

verify_registered_membership() {
  local outing_id="$1"
  local user_id="$2"
  local opted_in="$3"

  TEST_OUTING_ID="$outing_id" \
  TEST_USER_ID="$user_id" \
  EXPECTED_OPTED_IN="$opted_in" \
  node \
    --env-file=.env \
    --input-type=module \
    <<'NODE'
import {
  createClient,
} from '@supabase/supabase-js';

const expectedOptedIn =
  process.env
    .EXPECTED_OPTED_IN ===
      'true';

const supabase =
  createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SECRET_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );

const {
  data,
  error,
} =
  await supabase
    .from(
      'outing_members',
    )
    .select(
      'id, role, opted_in, opted_in_at, removed_at',
    )
    .eq(
      'outing_id',
      process.env.TEST_OUTING_ID,
    )
    .eq(
      'user_id',
      process.env.TEST_USER_ID,
    )
    .is(
      'removed_at',
      null,
    )
    .single();

if (
  error ||
  !data
) {
  console.error(
    'Registered outing membership was not found.',
  );

  process.exit(1);
}

if (
  data.role !==
    'member'
) {
  console.error(
    'Joined user does not have member role.',
  );

  process.exit(1);
}

if (
  data.opted_in !==
    expectedOptedIn
) {
  console.error(
    'Payer-selection consent did not match the expected value.',
  );

  process.exit(1);
}

if (
  expectedOptedIn &&
  !data.opted_in_at
) {
  console.error(
    'opted_in_at was not recorded.',
  );

  process.exit(1);
}

if (
  !expectedOptedIn &&
  data.opted_in_at !==
    null
) {
  console.error(
    'opted_in_at should be null while opted out.',
  );

  process.exit(1);
}

process.exit(0);
NODE
}

echo
echo "MOVA outing membership + invitation live test"
echo "API: $API_BASE"
echo
echo "Use TWO different confirmed MOVA accounts."
echo "Passwords are entered locally and are not printed."
echo

read -r -p "Account A email: " A_EMAIL
read -r -s -p "Account A password: " A_PASSWORD
echo

read -r -p "Account B email: " B_EMAIL
read -r -s -p "Account B password: " B_PASSWORD
echo
echo

echo "Checking backend health..."

curl -fsS \
  "$API_BASE/health" \
  >/dev/null

echo "✓ Backend is reachable"
echo

echo "Logging in both accounts..."

A_LOGIN="$(
  login \
    "$A_EMAIL" \
    "$A_PASSWORD"
)"

B_LOGIN="$(
  login \
    "$B_EMAIL" \
    "$B_PASSWORD"
)"

unset A_PASSWORD
unset B_PASSWORD

A_TOKEN="$(
  printf '%s' "$A_LOGIN" |
    json_value \
      'accessToken'
)"

A_ID="$(
  printf '%s' "$A_LOGIN" |
    json_value \
      'user.id'
)"

A_NAME="$(
  printf '%s' "$A_LOGIN" |
    json_value \
      'user.displayName'
)"

B_TOKEN="$(
  printf '%s' "$B_LOGIN" |
    json_value \
      'accessToken'
)"

B_ID="$(
  printf '%s' "$B_LOGIN" |
    json_value \
      'user.id'
)"

B_NAME="$(
  printf '%s' "$B_LOGIN" |
    json_value \
      'user.displayName'
)"

if [[ -z "$A_TOKEN" || -z "$A_ID" || -z "$A_NAME" ]]; then
  echo "✗ Account A login failed."
  exit 1
fi

if [[ -z "$B_TOKEN" || -z "$B_ID" || -z "$B_NAME" ]]; then
  echo "✗ Account B login failed."
  exit 1
fi

if [[ "$A_ID" == "$B_ID" ]]; then
  echo "✗ Account A and Account B must be different users."
  exit 1
fi

echo "✓ Both accounts logged in"

STARTS_AT="$(
  node -e '
    const date =
      new Date(
        Date.now() +
        3 *
          24 *
          60 *
          60 *
          1000,
      );

    process.stdout.write(
      date.toISOString(),
    );
  '
)"

CREATE_PAYLOAD="$(
  STARTS_AT_VALUE="$STARTS_AT" \
  node -e '
    process.stdout.write(
      JSON.stringify({
        title:
          "MOVA Invite Live Test",
        location:
          "Lagos",
        startsAt:
          process.env
            .STARTS_AT_VALUE,
        currency:
          "NGN",
        amountMinor:
          300000,
      }),
    );
  '
)"

echo
echo "TEST 1: Account A creates an outing"

CREATE_FILE="$TMP_DIR/create.json"

CREATE_STATUS="$(
  api_post_status \
    "$A_TOKEN" \
    "/outings" \
    "$CREATE_PAYLOAD" \
    "$CREATE_FILE"
)"

if [[ "$CREATE_STATUS" != "201" ]]; then
  echo "✗ Expected HTTP 201."
  echo "Received HTTP $CREATE_STATUS"
  cat "$CREATE_FILE"
  echo
  exit 1
fi

OUTING_ID="$(
  cat "$CREATE_FILE" |
    json_value \
      'id'
)"

if [[ -z "$OUTING_ID" ]]; then
  echo "✗ Outing ID was missing."
  exit 1
fi

echo "✓ Outing created"

echo
echo "TEST 2: Account A adds a named guest"

GUEST_FILE="$TMP_DIR/guest.json"

GUEST_STATUS="$(
  api_post_status \
    "$A_TOKEN" \
    "/outings/$OUTING_ID/members" \
    '{"displayName":"Guest Tester","optedIn":false}' \
    "$GUEST_FILE"
)"

if [[ "$GUEST_STATUS" != "200" ]]; then
  echo "✗ Expected HTTP 200 while adding guest."
  echo "Received HTTP $GUEST_STATUS"
  cat "$GUEST_FILE"
  echo
  exit 1
fi

if cat "$GUEST_FILE" |
  response_has_member \
    "Guest Tester" \
    "false"
then
  echo "✓ Guest appears in the outing and is not opted in"
else
  echo "✗ Guest was not returned correctly."
  cat "$GUEST_FILE"
  echo
  exit 1
fi

echo
echo "TEST 3: Account A generates an invitation code"

INVITE_FILE="$TMP_DIR/invite.json"

INVITE_STATUS="$(
  api_post_status \
    "$A_TOKEN" \
    "/outings/$OUTING_ID/invites" \
    '{}' \
    "$INVITE_FILE"
)"

if [[ "$INVITE_STATUS" != "200" ]]; then
  echo "✗ Expected HTTP 200 while generating invite."
  echo "Received HTTP $INVITE_STATUS"
  cat "$INVITE_FILE"
  echo
  exit 1
fi

INVITE_CODE="$(
  cat "$INVITE_FILE" |
    json_value \
      'code'
)"

EXPIRES_AT="$(
  cat "$INVITE_FILE" |
    json_value \
      'expiresAt'
)"

JOIN_URL="$(
  cat "$INVITE_FILE" |
    json_value \
      'joinUrl'
)"

if [[ ! "$INVITE_CODE" =~ ^[A-F0-9]{10}$ ]]; then
  echo "✗ Invite code has an unexpected format."
  exit 1
fi

if [[ -z "$EXPIRES_AT" ]]; then
  echo "✗ Invite expiry was missing."
  exit 1
fi

if [[ "$JOIN_URL" != "mova://join?code=$INVITE_CODE" ]]; then
  echo "✗ Invite join URL was unexpected."
  echo "$JOIN_URL"
  exit 1
fi

echo "✓ Invite code generated"

verify_invite_storage \
  "$OUTING_ID" \
  "$INVITE_CODE"

echo
echo "TEST 4: Account B previews the outing using the code"

LOOKUP_FILE="$TMP_DIR/lookup.json"

LOOKUP_STATUS="$(
  api_get_status \
    "$B_TOKEN" \
    "/invites/$INVITE_CODE" \
    "$LOOKUP_FILE"
)"

if [[ "$LOOKUP_STATUS" != "200" ]]; then
  echo "✗ Expected HTTP 200 for invite lookup."
  echo "Received HTTP $LOOKUP_STATUS"
  cat "$LOOKUP_FILE"
  echo
  exit 1
fi

LOOKUP_OUTING_ID="$(
  cat "$LOOKUP_FILE" |
    json_value \
      'id'
)"

if [[ "$LOOKUP_OUTING_ID" != "$OUTING_ID" ]]; then
  echo "✗ Invite lookup returned the wrong outing."
  exit 1
fi

echo "✓ Account B can preview the invited outing"

echo
echo "TEST 5: Account B joins the outing"

JOIN_FILE="$TMP_DIR/join.json"

JOIN_PAYLOAD="$(
  B_NAME_VALUE="$B_NAME" \
  node -e '
    process.stdout.write(
      JSON.stringify({
        displayName:
          process.env.B_NAME_VALUE,
      }),
    );
  '
)"

JOIN_STATUS="$(
  api_post_status \
    "$B_TOKEN" \
    "/invites/$INVITE_CODE/join" \
    "$JOIN_PAYLOAD" \
    "$JOIN_FILE"
)"

if [[ "$JOIN_STATUS" != "200" ]]; then
  echo "✗ Expected HTTP 200 while joining."
  echo "Received HTTP $JOIN_STATUS"
  cat "$JOIN_FILE"
  echo
  exit 1
fi

if cat "$JOIN_FILE" |
  response_has_member \
    "$B_NAME" \
    "false"
then
  echo "✓ Account B appears in the outing and is not opted in"
else
  echo "✗ Account B was not returned correctly as an outing member."
  cat "$JOIN_FILE"
  echo
  exit 1
fi

if verify_registered_membership \
  "$OUTING_ID" \
  "$B_ID" \
  "false"
then
  echo "✓ Account B membership is stored correctly in Supabase"
else
  echo "✗ Account B membership is invalid."
  exit 1
fi

echo
echo "TEST 6: Account B opts into payer selection"

CONSENT_FILE="$TMP_DIR/consent.json"

CONSENT_STATUS="$(
  api_post_status \
    "$B_TOKEN" \
    "/outings/$OUTING_ID/members/me/consent" \
    '{"optedIn":true}' \
    "$CONSENT_FILE"
)"

if [[ "$CONSENT_STATUS" != "200" ]]; then
  echo "✗ Expected HTTP 200 while opting in."
  echo "Received HTTP $CONSENT_STATUS"
  cat "$CONSENT_FILE"
  echo
  exit 1
fi

if cat "$CONSENT_FILE" |
  response_has_member \
    "$B_NAME" \
    "true"
then
  echo "✓ Account B is returned as opted into payer selection"
else
  echo "✗ Account B was not returned as opted in."
  cat "$CONSENT_FILE"
  echo
  exit 1
fi

if verify_registered_membership \
  "$OUTING_ID" \
  "$B_ID" \
  "true"
then
  echo "✓ Payer-selection consent persisted in Supabase"
else
  echo "✗ Payer-selection consent did not persist."
  exit 1
fi

echo
echo "TEST 7: Account A generates a replacement invitation"

REPLACEMENT_FILE="$TMP_DIR/replacement.json"

REPLACEMENT_STATUS="$(
  api_post_status \
    "$A_TOKEN" \
    "/outings/$OUTING_ID/invites" \
    '{}' \
    "$REPLACEMENT_FILE"
)"

if [[ "$REPLACEMENT_STATUS" != "200" ]]; then
  echo "✗ Could not generate replacement invite."
  cat "$REPLACEMENT_FILE"
  echo
  exit 1
fi

REPLACEMENT_CODE="$(
  cat "$REPLACEMENT_FILE" |
    json_value \
      'code'
)"

if [[ ! "$REPLACEMENT_CODE" =~ ^[A-F0-9]{10}$ ]]; then
  echo "✗ Replacement invite has an invalid format."
  exit 1
fi

if [[ "$REPLACEMENT_CODE" == "$INVITE_CODE" ]]; then
  echo "✗ Replacement invite unexpectedly reused the old code."
  exit 1
fi

echo "✓ Replacement invitation generated"

echo
echo "TEST 8: old invitation is revoked"

OLD_LOOKUP_FILE="$TMP_DIR/old-lookup.json"

OLD_LOOKUP_STATUS="$(
  api_get_status \
    "$B_TOKEN" \
    "/invites/$INVITE_CODE" \
    "$OLD_LOOKUP_FILE"
)"

if [[ "$OLD_LOOKUP_STATUS" != "404" ]]; then
  echo "✗ Expected old invitation to return HTTP 404."
  echo "Received HTTP $OLD_LOOKUP_STATUS"
  cat "$OLD_LOOKUP_FILE"
  echo
  exit 1
fi

echo "✓ Old invitation no longer works"

echo
echo "TEST 9: replacement invitation remains valid"

NEW_LOOKUP_FILE="$TMP_DIR/new-lookup.json"

NEW_LOOKUP_STATUS="$(
  api_get_status \
    "$B_TOKEN" \
    "/invites/$REPLACEMENT_CODE" \
    "$NEW_LOOKUP_FILE"
)"

if [[ "$NEW_LOOKUP_STATUS" != "200" ]]; then
  echo "✗ Replacement invitation was not valid."
  echo "Received HTTP $NEW_LOOKUP_STATUS"
  cat "$NEW_LOOKUP_FILE"
  echo
  exit 1
fi

echo "✓ Replacement invitation is active"

echo
echo "================================================"
echo "ALL OUTING MEMBERSHIP / INVITE LIVE TESTS PASSED"
echo "================================================"
echo

unset A_TOKEN
unset B_TOKEN
unset A_LOGIN
unset B_LOGIN