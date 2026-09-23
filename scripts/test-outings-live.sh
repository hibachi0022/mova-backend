#!/usr/bin/env bash

set -euo pipefail

API_BASE="${API_BASE:-http://localhost:4001/api/v1}"

TMP_DIR="$(mktemp -d)"
OUTING_ID=""

cleanup() {
  local original_status=$?

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
  console.error(
    'Cleanup skipped: required environment values are missing.',
  );

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

api_get() {
  local token="$1"
  local path="$2"

  curl -sS \
    "$API_BASE$path" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json"
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

outing_exists_in_list() {
  local target_id="$1"

  TARGET_OUTING_ID="$target_id" \
  node -e '
    const fs = require("fs");

    const data =
      JSON.parse(
        fs.readFileSync(
          0,
          "utf8",
        ),
      );

    const exists =
      Array.isArray(
        data.outings,
      ) &&
      data.outings.some(
        (outing) =>
          outing.id ===
            process.env
              .TARGET_OUTING_ID,
      );

    process.exit(
      exists ? 0 : 1,
    );
  '
}

validate_created_outing() {
  local target_id="$1"

  TARGET_OUTING_ID="$target_id" \
  node -e '
    const fs = require("fs");

    const outing =
      JSON.parse(
        fs.readFileSync(
          0,
          "utf8",
        ),
      );

    const valid =
      outing.id ===
        process.env
          .TARGET_OUTING_ID &&
      outing.title ===
        "MOVA Live API Test" &&
      outing.location ===
        "Lagos" &&
      outing.currency ===
        "NGN" &&
      outing.amountMinor ===
        125000 &&
      Array.isArray(
        outing.members,
      ) &&
      outing.members.length ===
        1 &&
      typeof outing.members[0].id ===
        "string" &&
      outing.members[0].id.length >
        0 &&
      typeof outing.members[0]
        .displayName ===
        "string" &&
      outing.members[0]
        .displayName.length >
        0 &&
      outing.members[0]
        .optedIn ===
        false;

    process.exit(
      valid ? 0 : 1,
    );
  '
}

verify_owner_membership() {
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
    .select(
      'id, user_id, role, removed_at',
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
  !data ||
  data.role !== 'owner'
) {
  process.exit(1);
}

process.exit(0);
NODE
}

echo
echo "MOVA outings live API test"
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
  echo "$A_LOGIN"
  exit 1
fi

if [[ -z "$B_TOKEN" || -z "$B_ID" ]]; then
  echo "✗ Account B login failed."
  echo "$B_LOGIN"
  exit 1
fi

if [[ "$A_ID" == "$B_ID" ]]; then
  echo "✗ Account A and Account B must be different users."
  exit 1
fi

echo "✓ Both accounts logged in"
echo

STARTS_AT="$(
  node -e '
    const date =
      new Date(
        Date.now() +
        3 * 24 * 60 * 60 * 1000,
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
          "MOVA Live API Test",
        location:
          "Lagos",
        startsAt:
          process.env
            .STARTS_AT_VALUE,
        currency:
          "NGN",
        amountMinor:
          125000,
      }),
    );
  '
)"

echo "TEST 1: creating an outing through NestJS"

CREATE_BODY="$TMP_DIR/create.json"

CREATE_STATUS="$(
  api_post_status \
    "$A_TOKEN" \
    "/outings" \
    "$CREATE_PAYLOAD" \
    "$CREATE_BODY"
)"

if [[ "$CREATE_STATUS" != "201" ]]; then
  echo "✗ Expected HTTP 201 but received $CREATE_STATUS"
  cat "$CREATE_BODY"
  echo
  exit 1
fi

OUTING_ID="$(
  cat "$CREATE_BODY" |
    json_value \
      'id'
)"

if [[ -z "$OUTING_ID" ]]; then
  echo "✗ Created outing did not contain an id."
  cat "$CREATE_BODY"
  echo
  exit 1
fi

if cat "$CREATE_BODY" |
  validate_created_outing \
    "$OUTING_ID"
then
  echo "✓ Outing created with the expected API shape"
else
  echo "✗ Created outing response was invalid."
  cat "$CREATE_BODY"
  echo
  exit 1
fi

echo
echo "TEST 2: creator automatically became owner"

if verify_owner_membership \
  "$OUTING_ID" \
  "$A_ID"
then
  echo "✓ Creator has an active owner membership in Supabase"
else
  echo "✗ Creator owner membership was not found."
  exit 1
fi

echo
echo "TEST 3: GET /outings includes the new outing"

LIST_BODY="$(
  api_get \
    "$A_TOKEN" \
    "/outings"
)"

if printf '%s' "$LIST_BODY" |
  outing_exists_in_list \
    "$OUTING_ID"
then
  echo "✓ New outing appears in Account A's outing list"
else
  echo "✗ New outing was missing from Account A's list."
  echo "$LIST_BODY"
  exit 1
fi

echo
echo "TEST 4: GET /outings/:id returns the outing"

DETAIL_BODY="$TMP_DIR/detail.json"

DETAIL_STATUS="$(
  api_get_status \
    "$A_TOKEN" \
    "/outings/$OUTING_ID" \
    "$DETAIL_BODY"
)"

if [[ "$DETAIL_STATUS" != "200" ]]; then
  echo "✗ Expected HTTP 200 but received $DETAIL_STATUS"
  cat "$DETAIL_BODY"
  echo
  exit 1
fi

if cat "$DETAIL_BODY" |
  validate_created_outing \
    "$OUTING_ID"
then
  echo "✓ Account A can load the outing and its owner member"
else
  echo "✗ Outing detail response was invalid."
  cat "$DETAIL_BODY"
  echo
  exit 1
fi

echo
echo "TEST 5: unrelated user cannot read the private outing"

PRIVATE_BODY="$TMP_DIR/private.json"

PRIVATE_STATUS="$(
  api_get_status \
    "$B_TOKEN" \
    "/outings/$OUTING_ID" \
    "$PRIVATE_BODY"
)"

if [[ "$PRIVATE_STATUS" == "404" ]]; then
  echo "✓ Account B receives HTTP 404"
else
  echo "✗ Expected Account B to receive HTTP 404."
  echo "Received HTTP $PRIVATE_STATUS"
  cat "$PRIVATE_BODY"
  echo
  exit 1
fi

echo
echo "=========================================="
echo "ALL OUTINGS LIVE API TESTS PASSED"
echo "=========================================="
echo

unset A_TOKEN
unset B_TOKEN
unset A_LOGIN
unset B_LOGIN