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

get_registered_member_id() {
  local outing_id="$1"
  local user_id="$2"

  TEST_OUTING_ID="$outing_id" \
  TEST_USER_ID="$user_id" \
  node \
    --env-file=.env \
    --input-type=module \
    <<'NODE'
import {
  createClient,
} from '@supabase/supabase-js';

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
    .from('outing_members')
    .select('id')
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
  process.exit(1);
}

process.stdout.write(
  data.id,
);
NODE
}

verify_selected_member() {
  local outing_id="$1"
  local selected_member_id="$2"

  TEST_OUTING_ID="$outing_id" \
  SELECTED_MEMBER_ID="$selected_member_id" \
  node \
    --env-file=.env \
    --input-type=module \
    <<'NODE'
import {
  createClient,
} from '@supabase/supabase-js';

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
    .from('outings')
    .select('selected_member_id')
    .eq(
      'id',
      process.env.TEST_OUTING_ID,
    )
    .single();

if (
  error ||
  !data
) {
  process.exit(1);
}

process.exit(
  data.selected_member_id ===
    process.env.SELECTED_MEMBER_ID
    ? 0
    : 1,
);
NODE
}

verify_selection_cleared() {
  local outing_id="$1"

  TEST_OUTING_ID="$outing_id" \
  node \
    --env-file=.env \
    --input-type=module \
    <<'NODE'
import {
  createClient,
} from '@supabase/supabase-js';

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
    .from('outings')
    .select('selected_member_id')
    .eq(
      'id',
      process.env.TEST_OUTING_ID,
    )
    .single();

if (
  error ||
  !data
) {
  process.exit(1);
}

process.exit(
  data.selected_member_id === null
    ? 0
    : 1,
);
NODE
}

verify_spin_audit_count() {
  local outing_id="$1"
  local expected_count="$2"

  TEST_OUTING_ID="$outing_id" \
  EXPECTED_COUNT="$expected_count" \
  node \
    --env-file=.env \
    --input-type=module \
    <<'NODE'
import {
  createClient,
} from '@supabase/supabase-js';

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
  count,
  error,
} =
  await supabase
    .from(
      'outing_roulette_spins',
    )
    .select(
      'id',
      {
        count: 'exact',
        head: true,
      },
    )
    .eq(
      'outing_id',
      process.env.TEST_OUTING_ID,
    );

if (error) {
  process.exit(1);
}

process.exit(
  count ===
    Number(
      process.env.EXPECTED_COUNT,
    )
    ? 0
    : 1,
);
NODE
}

echo
echo "MOVA outing roulette live test"
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

if [[ -z "$A_TOKEN" || -z "$A_ID" ]]; then
  echo "✗ Account A login failed."
  exit 1
fi

if [[ -z "$B_TOKEN" || -z "$B_ID" ]]; then
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
          "MOVA Roulette Live Test",
        location:
          "Lagos",
        startsAt:
          process.env
            .STARTS_AT_VALUE,
        currency:
          "NGN",
        amountMinor:
          400000,
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
echo "TEST 2: Account A generates an invitation"

INVITE_FILE="$TMP_DIR/invite.json"

INVITE_STATUS="$(
  api_post_status \
    "$A_TOKEN" \
    "/outings/$OUTING_ID/invites" \
    '{}' \
    "$INVITE_FILE"
)"

if [[ "$INVITE_STATUS" != "200" ]]; then
  echo "✗ Could not generate invitation."
  cat "$INVITE_FILE"
  echo
  exit 1
fi

INVITE_CODE="$(
  cat "$INVITE_FILE" |
    json_value \
      'code'
)"

if [[ ! "$INVITE_CODE" =~ ^[A-F0-9]{10}$ ]]; then
  echo "✗ Invalid invitation code."
  exit 1
fi

echo "✓ Invitation generated"

echo
echo "TEST 3: Account B joins the outing"

JOIN_FILE="$TMP_DIR/join.json"

JOIN_STATUS="$(
  api_post_status \
    "$B_TOKEN" \
    "/invites/$INVITE_CODE/join" \
    '{}' \
    "$JOIN_FILE"
)"

if [[ "$JOIN_STATUS" != "200" ]]; then
  echo "✗ Account B could not join."
  echo "Received HTTP $JOIN_STATUS"
  cat "$JOIN_FILE"
  echo
  exit 1
fi

echo "✓ Account B joined the outing"

A_MEMBER_ID="$(
  get_registered_member_id \
    "$OUTING_ID" \
    "$A_ID"
)"

B_MEMBER_ID="$(
  get_registered_member_id \
    "$OUTING_ID" \
    "$B_ID"
)"

if [[ -z "$A_MEMBER_ID" || -z "$B_MEMBER_ID" ]]; then
  echo "✗ Could not load registered member IDs."
  exit 1
fi

echo "✓ Both registered memberships found"

echo
echo "TEST 4: only Account A opts in"

A_CONSENT_FILE="$TMP_DIR/a-consent.json"

A_CONSENT_STATUS="$(
  api_post_status \
    "$A_TOKEN" \
    "/outings/$OUTING_ID/members/me/consent" \
    '{"optedIn":true}' \
    "$A_CONSENT_FILE"
)"

if [[ "$A_CONSENT_STATUS" != "200" ]]; then
  echo "✗ Account A could not opt in."
  cat "$A_CONSENT_FILE"
  echo
  exit 1
fi

echo "✓ Account A opted in"

echo
echo "TEST 5: roulette rejects only one eligible member"

ONE_SPIN_FILE="$TMP_DIR/one-spin.json"

ONE_SPIN_STATUS="$(
  api_post_status \
    "$A_TOKEN" \
    "/outings/$OUTING_ID/roulette" \
    '{}' \
    "$ONE_SPIN_FILE"
)"

if [[ "$ONE_SPIN_STATUS" != "409" ]]; then
  echo "✗ Expected HTTP 409 with one eligible member."
  echo "Received HTTP $ONE_SPIN_STATUS"
  cat "$ONE_SPIN_FILE"
  echo
  exit 1
fi

echo "✓ Roulette requires at least two eligible members"

echo
echo "TEST 6: Account B opts in"

B_CONSENT_FILE="$TMP_DIR/b-consent.json"

B_CONSENT_STATUS="$(
  api_post_status \
    "$B_TOKEN" \
    "/outings/$OUTING_ID/members/me/consent" \
    '{"optedIn":true}' \
    "$B_CONSENT_FILE"
)"

if [[ "$B_CONSENT_STATUS" != "200" ]]; then
  echo "✗ Account B could not opt in."
  cat "$B_CONSENT_FILE"
  echo
  exit 1
fi

echo "✓ Account B opted in"

echo
echo "TEST 7: roulette selects one eligible member"

SPIN_FILE="$TMP_DIR/spin.json"

SPIN_STATUS="$(
  api_post_status \
    "$A_TOKEN" \
    "/outings/$OUTING_ID/roulette" \
    '{}' \
    "$SPIN_FILE"
)"

if [[ "$SPIN_STATUS" != "200" ]]; then
  echo "✗ Expected HTTP 200 for roulette."
  echo "Received HTTP $SPIN_STATUS"
  cat "$SPIN_FILE"
  echo
  exit 1
fi

WINNER="$(
  cat "$SPIN_FILE" |
    json_value \
      'selectedMemberId'
)"

if [[ "$WINNER" != "$A_MEMBER_ID" && "$WINNER" != "$B_MEMBER_ID" ]]; then
  echo "✗ Roulette selected an ineligible member."
  echo "Winner: $WINNER"
  exit 1
fi

echo "✓ Roulette selected an eligible registered member"

if verify_selected_member \
  "$OUTING_ID" \
  "$WINNER"
then
  echo "✓ selected_member_id persisted in Supabase"
else
  echo "✗ Roulette winner was not persisted."
  exit 1
fi

if verify_spin_audit_count \
  "$OUTING_ID" \
  "1"
then
  echo "✓ First roulette spin was audited"
else
  echo "✗ First roulette audit record is missing."
  exit 1
fi

echo
echo "TEST 8: repeated spin returns the same winner"

SECOND_SPIN_FILE="$TMP_DIR/second-spin.json"

SECOND_SPIN_STATUS="$(
  api_post_status \
    "$B_TOKEN" \
    "/outings/$OUTING_ID/roulette" \
    '{}' \
    "$SECOND_SPIN_FILE"
)"

if [[ "$SECOND_SPIN_STATUS" != "200" ]]; then
  echo "✗ Repeated spin failed unexpectedly."
  cat "$SECOND_SPIN_FILE"
  echo
  exit 1
fi

SECOND_WINNER="$(
  cat "$SECOND_SPIN_FILE" |
    json_value \
      'selectedMemberId'
)"

if [[ "$SECOND_WINNER" != "$WINNER" ]]; then
  echo "✗ Repeated spin changed the winner."
  exit 1
fi

if verify_spin_audit_count \
  "$OUTING_ID" \
  "1"
then
  echo "✓ Repeated spin did not create another audit record"
else
  echo "✗ Repeated spin created an unexpected audit record."
  exit 1
fi

echo
echo "TEST 9: Account B opts out and clears the stale winner"

B_OPTOUT_FILE="$TMP_DIR/b-optout.json"

B_OPTOUT_STATUS="$(
  api_post_status \
    "$B_TOKEN" \
    "/outings/$OUTING_ID/members/me/consent" \
    '{"optedIn":false}' \
    "$B_OPTOUT_FILE"
)"

if [[ "$B_OPTOUT_STATUS" != "200" ]]; then
  echo "✗ Account B could not opt out."
  cat "$B_OPTOUT_FILE"
  echo
  exit 1
fi

if verify_selection_cleared \
  "$OUTING_ID"
then
  echo "✓ Eligibility change cleared selected_member_id"
else
  echo "✗ Old roulette winner was not cleared."
  exit 1
fi

echo
echo "TEST 10: roulette is blocked again with one eligible member"

REDUCED_FILE="$TMP_DIR/reduced.json"

REDUCED_STATUS="$(
  api_post_status \
    "$A_TOKEN" \
    "/outings/$OUTING_ID/roulette" \
    '{}' \
    "$REDUCED_FILE"
)"

if [[ "$REDUCED_STATUS" != "409" ]]; then
  echo "✗ Expected HTTP 409 after Account B opted out."
  echo "Received HTTP $REDUCED_STATUS"
  cat "$REDUCED_FILE"
  echo
  exit 1
fi

echo "✓ Reduced eligible roster cannot spin"

echo
echo "TEST 11: Account B opts back in"

B_REOPT_FILE="$TMP_DIR/b-reopt.json"

B_REOPT_STATUS="$(
  api_post_status \
    "$B_TOKEN" \
    "/outings/$OUTING_ID/members/me/consent" \
    '{"optedIn":true}' \
    "$B_REOPT_FILE"
)"

if [[ "$B_REOPT_STATUS" != "200" ]]; then
  echo "✗ Account B could not opt back in."
  cat "$B_REOPT_FILE"
  echo
  exit 1
fi

echo "✓ Account B opted back in"

echo
echo "TEST 12: new eligible roster can spin again"

THIRD_SPIN_FILE="$TMP_DIR/third-spin.json"

THIRD_SPIN_STATUS="$(
  api_post_status \
    "$B_TOKEN" \
    "/outings/$OUTING_ID/roulette" \
    '{}' \
    "$THIRD_SPIN_FILE"
)"

if [[ "$THIRD_SPIN_STATUS" != "200" ]]; then
  echo "✗ Second valid roulette cycle failed."
  echo "Received HTTP $THIRD_SPIN_STATUS"
  cat "$THIRD_SPIN_FILE"
  echo
  exit 1
fi

NEW_WINNER="$(
  cat "$THIRD_SPIN_FILE" |
    json_value \
      'selectedMemberId'
)"

if [[ "$NEW_WINNER" != "$A_MEMBER_ID" && "$NEW_WINNER" != "$B_MEMBER_ID" ]]; then
  echo "✗ Second cycle selected an ineligible member."
  exit 1
fi

if verify_selected_member \
  "$OUTING_ID" \
  "$NEW_WINNER"
then
  echo "✓ New winner persisted"
else
  echo "✗ New winner was not persisted."
  exit 1
fi

if verify_spin_audit_count \
  "$OUTING_ID" \
  "2"
then
  echo "✓ Two completed roulette cycles are audited"
else
  echo "✗ Expected exactly two roulette audit records."
  exit 1
fi

echo
echo "TEST 13: outing detail exposes the current selected member"

DETAIL_FILE="$TMP_DIR/detail.json"

DETAIL_STATUS="$(
  api_get_status \
    "$A_TOKEN" \
    "/outings/$OUTING_ID" \
    "$DETAIL_FILE"
)"

if [[ "$DETAIL_STATUS" != "200" ]]; then
  echo "✗ Could not load outing detail."
  cat "$DETAIL_FILE"
  echo
  exit 1
fi

DETAIL_WINNER="$(
  cat "$DETAIL_FILE" |
    json_value \
      'selectedMemberId'
)"

if [[ "$DETAIL_WINNER" != "$NEW_WINNER" ]]; then
  echo "✗ Outing API did not expose the persisted winner."
  exit 1
fi

echo "✓ GET /outings/:id returns the current selected member"

echo
echo "=========================================="
echo "ALL OUTING ROULETTE LIVE TESTS PASSED"
echo "=========================================="
echo

unset A_TOKEN
unset B_TOKEN
unset A_LOGIN
unset B_LOGIN