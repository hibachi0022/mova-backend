#!/usr/bin/env bash

set -euo pipefail

API_BASE="${API_BASE:-https://api.vectraservices.com.ng/api/v1}"

TMP_DIR="$(mktemp -d)"

OUTING_ID=""
TEST_SUCCESS="0"

cleanup() {
  local original_status=$?

  trap - EXIT
  set +e

  unset A_PASSWORD
  unset B_PASSWORD

  unset A_TOKEN
  unset B_TOKEN
  unset PAYER_TOKEN
  unset NONPAYER_TOKEN

  unset A_LOGIN
  unset B_LOGIN

  if [[ -n "${OUTING_ID:-}" ]]; then
    if [[ "$TEST_SUCCESS" == "1" ]]; then
      echo
      echo "Cleaning up successful live-test outing..."

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
    'Cleanup skipped because Supabase environment values are unavailable.',
  );

  process.exit(0);
}

const supabase =
  createClient(
    url,
    secret,
    {
      auth: {
        persistSession:
          false,

        autoRefreshToken:
          false,

        detectSessionInUrl:
          false,
      },
    },
  );

const {
  error,
} =
  await supabase
    .from(
      'outings',
    )
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
  '✓ Live-test outing removed from MOVA',
);
NODE
    else
      echo
      echo "Test did not complete successfully."
      echo
      echo "The test outing was preserved for debugging:"
      echo "$OUTING_ID"
      echo
      echo "Do not delete it until we inspect any failure."
    fi
  fi

  rm -rf "$TMP_DIR"

  exit "$original_status"
}

trap cleanup EXIT

json_value() {
  local json_path="$1"

  JSON_PATH="$json_path" \
  node -e '
    const fs =
      require(
        "fs",
      );

    const input =
      fs.readFileSync(
        0,
        "utf8",
      );

    try {
      const data =
        JSON.parse(
          input,
        );

      const parts =
        process.env
          .JSON_PATH
          .split(
            ".",
          );

      let value =
        data;

      for (
        const part
        of parts
      ) {
        value =
          value?.[part];
      }

      if (
        value ===
          undefined ||
        value ===
          null
      ) {
        process.stdout.write(
          "",
        );
      } else if (
        typeof value ===
        "string"
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
      process.stdout.write(
        "",
      );
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
          process.env
            .EMAIL_VALUE,

        password:
          process.env
            .PASSWORD_VALUE,
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
        persistSession:
          false,

        autoRefreshToken:
          false,

        detectSessionInUrl:
          false,
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
      'id',
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
    'Unable to locate registered outing member.',
  );

  process.exit(
    1,
  );
}

process.stdout.write(
  data.id,
);
NODE
}

verify_card_available() {
  local file="$1"

  OPTIONS_FILE="$file" \
  node -e '
    const fs =
      require(
        "fs",
      );

    const body =
      JSON.parse(
        fs.readFileSync(
          process.env
            .OPTIONS_FILE,
          "utf8",
        ),
      );

    const card =
      body.methods?.find(
        item =>
          item.id ===
          "card",
      );

    if (
      !card ||
      card.available !==
        true
    ) {
      if (
        card?.reason
      ) {
        console.error(
          card.reason,
        );
      }

      process.exit(
        1,
      );
    }
  '
}

verify_checkout_url() {
  local value="$1"

  CHECKOUT_URL="$value" \
  node -e '
    try {
      const url =
        new URL(
          process.env
            .CHECKOUT_URL,
        );

      if (
        url.protocol !==
          "https:" ||
        url.username ||
        url.password
      ) {
        process.exit(
          1,
        );
      }

      process.exit(
        0,
      );
    } catch {
      process.exit(
        1,
      );
    }
  '
}

echo
echo "================================================"
echo "MOVA PAYSTACK END-TO-END TEST"
echo "================================================"
echo
echo "API:"
echo "$API_BASE"
echo
echo "This test uses Paystack TEST MODE."
echo "No real money should be used."
echo
echo "You need TWO different confirmed MOVA accounts."
echo "Passwords are entered locally and are never printed."
echo

if [[ ! -f ".env" ]]; then
  echo "✗ Run this script from the mova-backend folder."
  echo "✗ .env was not found."
  exit 1
fi

echo "Checking production backend..."

if ! curl -fsS \
  "$API_BASE/health" \
  >/dev/null
then
  echo "✗ MOVA backend is not reachable."
  exit 1
fi

echo "✓ Backend is reachable"

echo
read -r -p "Account A email: " A_EMAIL
read -r -s -p "Account A password: " A_PASSWORD
echo

read -r -p "Account B email: " B_EMAIL
read -r -s -p "Account B password: " B_PASSWORD
echo
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
  echo "✗ Account A and Account B must be different accounts."
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
          "MOVA Paystack End-to-End Test",

        location:
          "Lagos",

        startsAt:
          process.env
            .STARTS_AT_VALUE,

        currency:
          "NGN",

        amountMinor:
          100000,
      }),
    );
  '
)"

echo
echo "TEST 1: Creating test outing"

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
echo "  $OUTING_ID"

echo
echo "TEST 2: Creating invitation"

INVITE_FILE="$TMP_DIR/invite.json"

INVITE_STATUS="$(
  api_post_status \
    "$A_TOKEN" \
    "/outings/$OUTING_ID/invites" \
    '{}' \
    "$INVITE_FILE"
)"

if [[ "$INVITE_STATUS" != "200" ]]; then
  echo "✗ Invitation creation failed."
  cat "$INVITE_FILE"
  echo
  exit 1
fi

INVITE_CODE="$(
  cat "$INVITE_FILE" |
    json_value \
      'code'
)"

if [[ -z "$INVITE_CODE" ]]; then
  echo "✗ Invitation code missing."
  exit 1
fi

echo "✓ Invitation created"

echo
echo "TEST 3: Account B joins outing"

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

echo "✓ Registered member IDs loaded"

echo
echo "TEST 4: Both members opt into payer selection"

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
echo "TEST 5: Running payer roulette"

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
  NONPAYER_TOKEN="$B_TOKEN"
  PAYER_LABEL="Account A"
elif [[ "$WINNER" == "$B_MEMBER_ID" ]]; then
  PAYER_TOKEN="$B_TOKEN"
  NONPAYER_TOKEN="$A_TOKEN"
  PAYER_LABEL="Account B"
else
  echo "✗ Roulette returned an unexpected member."
  exit 1
fi

echo "✓ $PAYER_LABEL was selected as payer"

echo
echo "TEST 6: Confirming Card is enabled"

OPTIONS_FILE="$TMP_DIR/options.json"

OPTIONS_STATUS="$(
  api_get_status \
    "$PAYER_TOKEN" \
    "/outings/$OUTING_ID/payment-options" \
    "$OPTIONS_FILE"
)"

if [[ "$OPTIONS_STATUS" != "200" ]]; then
  echo "✗ Payment options request failed."
  cat "$OPTIONS_FILE"
  echo
  exit 1
fi

if ! verify_card_available \
  "$OPTIONS_FILE"
then
  echo
  echo "✗ Card is not available."
  echo
  echo "Check Railway variables:"
  echo "PAYSTACK_SECRET_KEY"
  echo "PAYSTACK_OUTING_METHODS=card"
  echo "PAYSTACK_OUTING_CURRENCIES=NGN"
  echo
  cat "$OPTIONS_FILE"
  echo
  exit 1
fi

echo "✓ Card is available through Paystack"

echo
echo "TEST 7: Payment starts as unpaid"

STATUS_BEFORE_FILE="$TMP_DIR/status-before.json"

STATUS_BEFORE_HTTP="$(
  api_get_status \
    "$PAYER_TOKEN" \
    "/outings/$OUTING_ID/payment" \
    "$STATUS_BEFORE_FILE"
)"

if [[ "$STATUS_BEFORE_HTTP" != "200" ]]; then
  echo "✗ Payment status request failed."
  cat "$STATUS_BEFORE_FILE"
  echo
  exit 1
fi

STATUS_BEFORE="$(
  cat "$STATUS_BEFORE_FILE" |
    json_value \
      'status'
)"

if [[ "$STATUS_BEFORE" != "unpaid" ]]; then
  echo "✗ Expected unpaid status before checkout."
  cat "$STATUS_BEFORE_FILE"
  echo
  exit 1
fi

echo "✓ Payment is unpaid before checkout"

echo
echo "TEST 8: Non-selected member cannot pay"

NONPAYER_FILE="$TMP_DIR/nonpayer.json"

NONPAYER_STATUS="$(
  api_post_status \
    "$NONPAYER_TOKEN" \
    "/outings/$OUTING_ID/checkout" \
    '{"methodId":"card"}' \
    "$NONPAYER_FILE" \
    "mova-nonpayer-$(date +%s)"
)"

if [[ "$NONPAYER_STATUS" != "403" ]]; then
  echo "✗ Expected non-selected member to receive HTTP 403."
  echo "Received HTTP $NONPAYER_STATUS"
  cat "$NONPAYER_FILE"
  echo
  exit 1
fi

echo "✓ Non-selected member cannot start payment"

echo
echo "TEST 9: Selected payer starts Paystack checkout"

CHECKOUT_FILE="$TMP_DIR/checkout.json"

CHECKOUT_STATUS="$(
  api_post_status \
    "$PAYER_TOKEN" \
    "/outings/$OUTING_ID/checkout" \
    '{"methodId":"card"}' \
    "$CHECKOUT_FILE" \
    "mova-paystack-live-$(date +%s)"
)"

if [[ "$CHECKOUT_STATUS" != "200" ]]; then
  echo "✗ Paystack checkout initialization failed."
  echo "HTTP $CHECKOUT_STATUS"
  cat "$CHECKOUT_FILE"
  echo
  exit 1
fi

CHECKOUT_URL="$(
  cat "$CHECKOUT_FILE" |
    json_value \
      'checkoutUrl'
)"

if [[ -z "$CHECKOUT_URL" ]]; then
  echo "✗ Checkout URL missing."
  cat "$CHECKOUT_FILE"
  echo
  exit 1
fi

if ! verify_checkout_url \
  "$CHECKOUT_URL"
then
  echo "✗ Checkout URL is not a valid HTTPS URL."
  exit 1
fi

echo "✓ Paystack checkout created"
echo
echo "$CHECKOUT_URL"

echo
echo "TEST 10: Backend reports payment pending"

STATUS_PENDING_FILE="$TMP_DIR/status-pending.json"

STATUS_PENDING_HTTP="$(
  api_get_status \
    "$PAYER_TOKEN" \
    "/outings/$OUTING_ID/payment" \
    "$STATUS_PENDING_FILE"
)"

if [[ "$STATUS_PENDING_HTTP" != "200" ]]; then
  echo "✗ Could not read payment status."
  cat "$STATUS_PENDING_FILE"
  echo
  exit 1
fi

STATUS_PENDING="$(
  cat "$STATUS_PENDING_FILE" |
    json_value \
      'status'
)"

if [[ "$STATUS_PENDING" != "pending" ]]; then
  echo "✗ Expected payment to be pending after checkout creation."
  cat "$STATUS_PENDING_FILE"
  echo
  exit 1
fi

echo "✓ Checkout is pending until Paystack confirms payment"

echo
echo "================================================"
echo "COMPLETE THE PAYSTACK TEST PAYMENT"
echo "================================================"
echo
echo "Use Paystack TEST details only:"
echo
echo "Card:   4084 0840 8408 4081"
echo "Expiry: 09/27"
echo "CVV:    408"
echo
echo "Amount: NGN 1,000.00"
echo
echo "Do NOT enter a real card."
echo

if command -v open \
  >/dev/null 2>&1
then
  echo "Opening Paystack checkout in your browser..."
  open "$CHECKOUT_URL"
else
  echo "Open this URL manually:"
  echo "$CHECKOUT_URL"
fi

echo
read -r -p "After Paystack shows the test payment as successful, press ENTER here. " _

echo
echo "TEST 11: Waiting for Paystack webhook confirmation"

FINAL_STATE=""

for attempt in \
  $(seq 1 20)
do
  FINAL_FILE="$TMP_DIR/final-$attempt.json"

  FINAL_HTTP="$(
    api_get_status \
      "$PAYER_TOKEN" \
      "/outings/$OUTING_ID/payment" \
      "$FINAL_FILE"
  )"

  if [[ "$FINAL_HTTP" != "200" ]]; then
    echo "✗ Payment status endpoint returned HTTP $FINAL_HTTP"
    cat "$FINAL_FILE"
    echo
    exit 1
  fi

  FINAL_STATE="$(
    cat "$FINAL_FILE" |
      json_value \
        'status'
  )"

  if [[ "$FINAL_STATE" == "completed" ]]; then
    echo
    echo "✓ Paystack webhook confirmed the payment"

    PAID_AT="$(
      cat "$FINAL_FILE" |
        json_value \
          'paidAt'
    )"

    if [[ -n "$PAID_AT" ]]; then
      echo "✓ Paid at: $PAID_AT"
    fi

    TEST_SUCCESS="1"

    echo
    echo "================================================"
    echo "ALL PAYSTACK END-TO-END TESTS PASSED"
    echo "================================================"
    echo
    echo "Verified:"
    echo "✓ Two independent MOVA accounts"
    echo "✓ Outing creation"
    echo "✓ Invitation and join"
    echo "✓ Opt-in"
    echo "✓ Server-side payer roulette"
    echo "✓ Only selected payer can checkout"
    echo "✓ Paystack transaction initialization"
    echo "✓ Pending status before payment"
    echo "✓ Paystack test payment"
    echo "✓ Signed webhook delivery"
    echo "✓ Server-side Paystack verification"
    echo "✓ MOVA payment settlement"
    echo "✓ Trusted completed payment status"
    echo

    break
  fi

  if [[ "$FINAL_STATE" == "reconciliation_required" ]]; then
    echo
    echo "✗ Payment entered reconciliation."
    cat "$FINAL_FILE"
    echo
    exit 1
  fi

  if [[ "$FINAL_STATE" != "pending" ]]; then
    echo
    echo "✗ Unexpected payment state:"
    cat "$FINAL_FILE"
    echo
    exit 1
  fi

  echo "  Attempt $attempt/20: still pending..."

  sleep 3
done

if [[ "$FINAL_STATE" != "completed" ]]; then
  echo
  echo "✗ Payment was not confirmed within 60 seconds."
  echo
  echo "The outing has been preserved so we can inspect:"
  echo "$OUTING_ID"
  echo
  echo "Do not start another payment."
  exit 1
fi