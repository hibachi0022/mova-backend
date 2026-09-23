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

login() {
  local email="$1"
  local password="$2"

  EMAIL_VALUE="$email" \
  PASSWORD_VALUE="$password" \
  node -e '
    process.stdout.write(
      JSON.stringify({
        email:
          process.env.EMAIL_VALUE,
        password:
          process.env.PASSWORD_VALUE,
      }),
    );
  ' |
    curl -sS \
      -X POST \
      "$API_BASE/auth/login" \
      -H "Content-Type: application/json" \
      --data-binary @-
}

api_post_status() {
  local token="$1"
  local path="$2"
  local body="$3"
  local output_file="$4"
  local idempotency_key="${5:-}"

  if [[ -n "$idempotency_key" ]]; then
    curl -sS \
      -o "$output_file" \
      -w "%{http_code}" \
      -X POST \
      "$API_BASE$path" \
      -H "Authorization: Bearer $token" \
      -H "Content-Type: application/json" \
      -H "Idempotency-Key: $idempotency_key" \
      -d "$body"
  else
    curl -sS \
      -o "$output_file" \
      -w "%{http_code}" \
      -X POST \
      "$API_BASE$path" \
      -H "Authorization: Bearer $token" \
      -H "Content-Type: application/json" \
      -d "$body"
  fi
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

get_member_id() {
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

payment_intent_count() {
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
  count,
  error,
} =
  await supabase
    .from(
      'outing_payment_intents',
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

process.stdout.write(
  String(
    count ?? 0,
  ),
);
NODE
}

verify_paystack_not_configured() {
  node \
    --env-file=.env \
    --input-type=module \
    <<'NODE'
const key =
  process.env.PAYSTACK_SECRET_KEY
    ?.trim() ?? '';

if (
  key.startsWith('sk_test_') ||
  key.startsWith('sk_live_')
) {
  console.error(
    'PAYSTACK_SECRET_KEY is configured. This specific test expects Paystack to be disabled.',
  );

  process.exit(1);
}

process.exit(0);
NODE
}

verify_options_all_unavailable() {
  local input_file="$1"

  OPTIONS_FILE="$input_file" \
  node -e '
    const fs = require("fs");

    const body =
      JSON.parse(
        fs.readFileSync(
          process.env.OPTIONS_FILE,
          "utf8",
        ),
      );

    const expected = [
      "nfc",
      "apple_pay",
      "google_pay",
      "paypal",
      "bank_transfer",
      "card",
    ];

    if (
      !Array.isArray(
        body.methods,
      )
    ) {
      process.exit(1);
    }

    if (
      body.methods.length !==
      expected.length
    ) {
      process.exit(1);
    }

    for (
      const id of expected
    ) {
      const method =
        body.methods.find(
          item =>
            item.id === id,
        );

      if (
        !method ||
        method.available !==
          false ||
        typeof method.reason !==
          "string" ||
        !method.reason.trim()
      ) {
        process.exit(1);
      }
    }

    process.exit(0);
  '
}

echo
echo "MOVA outing payment-options live test"
echo "API: $API_BASE"
echo
echo "This test expects PAYSTACK_SECRET_KEY to be unconfigured."
echo

if ! verify_paystack_not_configured
then
  echo
  echo "✗ Remove PAYSTACK_SECRET_KEY temporarily before running this test."
  exit 1
fi

echo "✓ Paystack is not configured for this test"

echo
echo "Use TWO different confirmed MOVA accounts."
echo "Passwords stay local and are not printed."
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
  echo "✗ Use two different accounts."
  exit 1
fi

echo "✓ Both accounts logged in"

STARTS_AT="$(
  node -e '
    process.stdout.write(
      new Date(
        Date.now() +
          3 *
            24 *
            60 *
            60 *
            1000,
      ).toISOString(),
    );
  '
)"

CREATE_PAYLOAD="$(
  STARTS_AT_VALUE="$STARTS_AT" \
  node -e '
    process.stdout.write(
      JSON.stringify({
        title:
          "MOVA Payment Options Live Test",
        location:
          "Lagos",
        startsAt:
          process.env.STARTS_AT_VALUE,
        currency:
          "NGN",
        amountMinor:
          350000,
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
  echo "✗ Outing creation failed."
  echo "HTTP $CREATE_STATUS"
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
  echo "✗ Outing ID missing."
  exit 1
fi

echo "✓ Outing created"

echo
echo "TEST 2: payment options before payer selection"

OPTIONS_BEFORE="$TMP_DIR/options-before.json"

OPTIONS_BEFORE_STATUS="$(
  api_get_status \
    "$A_TOKEN" \
    "/outings/$OUTING_ID/payment-options" \
    "$OPTIONS_BEFORE"
)"

if [[ "$OPTIONS_BEFORE_STATUS" != "200" ]]; then
  echo "✗ Payment options endpoint failed."
  echo "HTTP $OPTIONS_BEFORE_STATUS"
  cat "$OPTIONS_BEFORE"
  echo
  exit 1
fi

if ! verify_options_all_unavailable \
  "$OPTIONS_BEFORE"
then
  echo "✗ Expected all methods to be unavailable before payer selection."
  cat "$OPTIONS_BEFORE"
  echo
  exit 1
fi

echo "✓ All methods unavailable before payer selection"

echo
echo "TEST 3: Account A creates invite"

INVITE_FILE="$TMP_DIR/invite.json"

INVITE_STATUS="$(
  api_post_status \
    "$A_TOKEN" \
    "/outings/$OUTING_ID/invites" \
    '{}' \
    "$INVITE_FILE"
)"

if [[ "$INVITE_STATUS" != "200" ]]; then
  echo "✗ Invitation generation failed."
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
  echo "✗ Invalid invite code."
  exit 1
fi

echo "✓ Invitation created"

echo
echo "TEST 4: Account B joins"

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
  echo "HTTP $JOIN_STATUS"
  cat "$JOIN_FILE"
  echo
  exit 1
fi

echo "✓ Account B joined"

A_MEMBER_ID="$(
  get_member_id \
    "$OUTING_ID" \
    "$A_ID"
)"

B_MEMBER_ID="$(
  get_member_id \
    "$OUTING_ID" \
    "$B_ID"
)"

echo "✓ Registered membership IDs loaded"

echo
echo "TEST 5: both members opt in"

A_CONSENT_FILE="$TMP_DIR/a-consent.json"

A_CONSENT_STATUS="$(
  api_post_status \
    "$A_TOKEN" \
    "/outings/$OUTING_ID/members/me/consent" \
    '{"optedIn":true}' \
    "$A_CONSENT_FILE"
)"

if [[ "$A_CONSENT_STATUS" != "200" ]]; then
  echo "✗ Account A opt-in failed."
  cat "$A_CONSENT_FILE"
  echo
  exit 1
fi

B_CONSENT_FILE="$TMP_DIR/b-consent.json"

B_CONSENT_STATUS="$(
  api_post_status \
    "$B_TOKEN" \
    "/outings/$OUTING_ID/members/me/consent" \
    '{"optedIn":true}' \
    "$B_CONSENT_FILE"
)"

if [[ "$B_CONSENT_STATUS" != "200" ]]; then
  echo "✗ Account B opt-in failed."
  cat "$B_CONSENT_FILE"
  echo
  exit 1
fi

echo "✓ Both members opted in"

echo
echo "TEST 6: roulette selects payer"

SPIN_FILE="$TMP_DIR/spin.json"

SPIN_STATUS="$(
  api_post_status \
    "$A_TOKEN" \
    "/outings/$OUTING_ID/roulette" \
    '{}' \
    "$SPIN_FILE"
)"

if [[ "$SPIN_STATUS" != "200" ]]; then
  echo "✗ Roulette failed."
  echo "HTTP $SPIN_STATUS"
  cat "$SPIN_FILE"
  echo
  exit 1
fi

WINNER="$(
  cat "$SPIN_FILE" |
    json_value \
      'selectedMemberId'
)"

if [[ "$WINNER" == "$A_MEMBER_ID" ]]; then
  PAYER_TOKEN="$A_TOKEN"
  PAYER_LABEL="Account A"
elif [[ "$WINNER" == "$B_MEMBER_ID" ]]; then
  PAYER_TOKEN="$B_TOKEN"
  PAYER_LABEL="Account B"
else
  echo "✗ Roulette returned an unexpected member."
  exit 1
fi

echo "✓ $PAYER_LABEL was selected as payer"

echo
echo "TEST 7: payment options after payer selection"

OPTIONS_AFTER="$TMP_DIR/options-after.json"

OPTIONS_AFTER_STATUS="$(
  api_get_status \
    "$PAYER_TOKEN" \
    "/outings/$OUTING_ID/payment-options" \
    "$OPTIONS_AFTER"
)"

if [[ "$OPTIONS_AFTER_STATUS" != "200" ]]; then
  echo "✗ Payment options endpoint failed after selection."
  cat "$OPTIONS_AFTER"
  echo
  exit 1
fi

if ! verify_options_all_unavailable \
  "$OPTIONS_AFTER"
then
  echo "✗ A payment method was unexpectedly available without Paystack."
  cat "$OPTIONS_AFTER"
  echo
  exit 1
fi

echo "✓ No payment method is falsely enabled without Paystack"

echo
echo "TEST 8: checkout is rejected while provider is unavailable"

BEFORE_COUNT="$(
  payment_intent_count \
    "$OUTING_ID"
)"

CHECKOUT_FILE="$TMP_DIR/checkout.json"

CHECKOUT_STATUS="$(
  api_post_status \
    "$PAYER_TOKEN" \
    "/outings/$OUTING_ID/checkout" \
    '{"methodId":"card"}' \
    "$CHECKOUT_FILE" \
    "payment-options-live-test-001"
)"

if [[ "$CHECKOUT_STATUS" != "422" ]]; then
  echo "✗ Expected HTTP 422 while Paystack is disabled."
  echo "Received HTTP $CHECKOUT_STATUS"
  cat "$CHECKOUT_FILE"
  echo
  exit 1
fi

AFTER_COUNT="$(
  payment_intent_count \
    "$OUTING_ID"
)"

if [[ "$BEFORE_COUNT" != "$AFTER_COUNT" ]]; then
  echo "✗ An unavailable checkout created a payment intent."
  echo "Before: $BEFORE_COUNT"
  echo "After:  $AFTER_COUNT"
  exit 1
fi

echo "✓ Checkout rejected safely"
echo "✓ No payment intent created"

echo
echo "TEST 9: unsupported method is also rejected"

PAYPAL_FILE="$TMP_DIR/paypal.json"

PAYPAL_STATUS="$(
  api_post_status \
    "$PAYER_TOKEN" \
    "/outings/$OUTING_ID/checkout" \
    '{"methodId":"paypal"}' \
    "$PAYPAL_FILE" \
    "payment-options-live-test-002"
)"

if [[ "$PAYPAL_STATUS" != "422" ]]; then
  echo "✗ Expected HTTP 422 for PayPal."
  echo "Received HTTP $PAYPAL_STATUS"
  cat "$PAYPAL_FILE"
  echo
  exit 1
fi

echo "✓ Unsupported method rejected"

FINAL_COUNT="$(
  payment_intent_count \
    "$OUTING_ID"
)"

if [[ "$FINAL_COUNT" != "0" ]]; then
  echo "✗ Expected zero payment intents."
  echo "Found: $FINAL_COUNT"
  exit 1
fi

echo "✓ Database contains zero payment attempts"

echo
echo "=============================================="
echo "ALL OUTING PAYMENT-OPTIONS LIVE TESTS PASSED"
echo "=============================================="
echo

unset A_TOKEN
unset B_TOKEN
unset PAYER_TOKEN
unset A_LOGIN
unset B_LOGIN