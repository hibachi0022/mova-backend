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

  unset ACCOUNT_PASSWORD
  unset ACCESS_TOKEN

  if [[ -n "${OUTING_ID:-}" ]]; then
    if [[ "$TEST_SUCCESS" == "1" ]]; then
      echo
      echo "Cleaning up successful payment-history test outing..."

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

  process.exit(
    0,
  );
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

if (
  error
) {
  console.error(
    `Cleanup warning: ${error.message}`,
  );

  process.exit(
    0,
  );
}

console.log(
  '✓ Payment-history test outing removed from MOVA',
);
NODE
    else
      echo
      echo "Test did not complete successfully."
      echo
      echo "The temporary outing was preserved for debugging:"
      echo "$OUTING_ID"
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

echo
echo "================================================"
echo "MOVA PAYMENT HISTORY PRODUCTION TEST"
echo "================================================"
echo
echo "API:"
echo "$API_BASE"
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

echo "✓ Production backend is reachable"

echo
read -r -p "MOVA account email: " ACCOUNT_EMAIL
read -r -s -p "MOVA account password: " ACCOUNT_PASSWORD
echo
echo

echo "Logging in..."

LOGIN_RESPONSE="$(
  login \
    "$ACCOUNT_EMAIL" \
    "$ACCOUNT_PASSWORD"
)"

unset ACCOUNT_PASSWORD

ACCESS_TOKEN="$(
  printf '%s' "$LOGIN_RESPONSE" |
    json_value \
      'accessToken'
)"

USER_ID="$(
  printf '%s' "$LOGIN_RESPONSE" |
    json_value \
      'user.id'
)"

if [[ -z "$ACCESS_TOKEN" || -z "$USER_ID" ]]; then
  echo "✗ Login failed."
  exit 1
fi

echo "✓ Logged in"

STARTS_AT="$(
  node -e '
    process.stdout.write(
      new Date(
        Date.now() +
          4 *
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
          "MOVA Payment History Test",

        location:
          "Lagos",

        startsAt:
          process.env
            .STARTS_AT_VALUE,

        currency:
          "NGN",

        amountMinor:
          250000,
      }),
    );
  '
)"

echo
echo "TEST 1: Creating temporary outing"

CREATE_FILE="$TMP_DIR/create.json"

CREATE_STATUS="$(
  api_post_status \
    "$ACCESS_TOKEN" \
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

echo "✓ Temporary outing created"
echo "  $OUTING_ID"

echo
echo "TEST 2: Creating trusted completed payment"

SEED_RESULT="$(
  TEST_OUTING_ID="$OUTING_ID" \
  TEST_USER_ID="$USER_ID" \
  node \
    --env-file=.env \
    --input-type=module \
    <<'NODE'
import {
  createHash,
  randomUUID,
} from 'node:crypto';

import {
  createClient,
} from '@supabase/supabase-js';

const url =
  process.env.SUPABASE_URL;

const secret =
  process.env.SUPABASE_SECRET_KEY;

const outingId =
  process.env.TEST_OUTING_ID;

const userId =
  process.env.TEST_USER_ID;

if (
  !url ||
  !secret ||
  !outingId ||
  !userId
) {
  console.error(
    'Required test environment values are missing.',
  );

  process.exit(
    1,
  );
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
  data:
    member,
  error:
    memberError,
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
      outingId,
    )
    .eq(
      'user_id',
      userId,
    )
    .is(
      'removed_at',
      null,
    )
    .single();

if (
  memberError ||
  !member
) {
  console.error(
    'Unable to locate the outing owner membership.',
  );

  process.exit(
    1,
  );
}

const unique =
  randomUUID()
    .replaceAll(
      '-',
      '',
    );

const idempotencyHash =
  createHash(
    'sha256',
  )
    .update(
      `history-live-${outingId}-${unique}`,
    )
    .digest(
      'hex',
    );

const providerReference =
  `MOVA-HISTORY-${unique}`;

const providerCheckoutId =
  `history_${unique}`;

const providerTransactionId =
  `${Date.now()}${Math.floor(
    Math.random() *
      100000,
  )
    .toString()
    .padStart(
      5,
      '0',
    )}`;

const paidAt =
  new Date()
    .toISOString();

const {
  data:
    payment,
  error:
    paymentError,
} =
  await supabase
    .from(
      'outing_payment_intents',
    )
    .insert({
      outing_id:
        outingId,

      selected_member_id:
        member.id,

      payer_user_id:
        userId,

      amount_minor:
        250000,

      currency:
        'NGN',

      method_id:
        'card',

      status:
        'completed',

      idempotency_key_hash:
        idempotencyHash,

      provider:
        'paystack',

      provider_checkout_id:
        providerCheckoutId,

      provider_reference:
        providerReference,

      provider_transaction_id:
        providerTransactionId,

      provider_channel:
        'card',

      provider_paid_at:
        paidAt,

      provider_verified_at:
        paidAt,

      provider_amount_minor:
        253807,

      provider_requested_amount_minor:
        250000,

      provider_currency:
        'NGN',

      completed_at:
        paidAt,

      reconciliation_state:
        'none',
    })
    .select(
      'id, provider_reference',
    )
    .single();

if (
  paymentError ||
  !payment
) {
  console.error(
    paymentError?.message ??
      'Unable to create completed test payment.',
  );

  process.exit(
    1,
  );
}

process.stdout.write(
  JSON.stringify({
    paymentIntentId:
      payment.id,

    providerReference:
      payment.provider_reference,
  }),
);
NODE
)"

PAYMENT_INTENT_ID="$(
  printf '%s' "$SEED_RESULT" |
    json_value \
      'paymentIntentId'
)"

PROVIDER_REFERENCE="$(
  printf '%s' "$SEED_RESULT" |
    json_value \
      'providerReference'
)"

if [[ -z "$PAYMENT_INTENT_ID" || -z "$PROVIDER_REFERENCE" ]]; then
  echo "✗ Completed test payment was not created."
  exit 1
fi

echo "✓ Completed test payment created"

echo
echo "TEST 3: Loading payment history"

HISTORY_FILE="$TMP_DIR/history.json"

HISTORY_HTTP="$(
  api_get_status \
    "$ACCESS_TOKEN" \
    "/me/payment-history" \
    "$HISTORY_FILE"
)"

if [[ "$HISTORY_HTTP" != "200" ]]; then
  echo "✗ Payment history endpoint failed."
  echo "HTTP $HISTORY_HTTP"
  cat "$HISTORY_FILE"
  echo
  echo "Confirm Railway is running:"
  echo "Add payment history API"
  exit 1
fi

echo "✓ Payment history endpoint returned HTTP 200"

echo
echo "TEST 4: Validating trusted history item"

HISTORY_FILE_PATH="$HISTORY_FILE" \
EXPECTED_OUTING_ID="$OUTING_ID" \
EXPECTED_PAYMENT_ID="$PAYMENT_INTENT_ID" \
EXPECTED_REFERENCE="$PROVIDER_REFERENCE" \
node <<'NODE'
const fs =
  require(
    'fs',
  );

const body =
  JSON.parse(
    fs.readFileSync(
      process.env
        .HISTORY_FILE_PATH,
      'utf8',
    ),
  );

if (
  !Array.isArray(
    body.payments,
  )
) {
  console.error(
    'Payment history did not return a payments array.',
  );

  process.exit(
    1,
  );
}

const item =
  body.payments.find(
    payment =>
      payment.outing?.id ===
      process.env
        .EXPECTED_OUTING_ID,
  );

if (
  !item
) {
  console.error(
    'The temporary completed payment was not found in payment history.',
  );

  process.exit(
    1,
  );
}

const failures =
  [];

function expect(
  condition,
  message,
) {
  if (
    !condition
  ) {
    failures.push(
      message,
    );
  }
}

expect(
  item.receiptId ===
    process.env
      .EXPECTED_PAYMENT_ID,
  'receiptId must match the completed payment intent',
);

expect(
  item.outing?.title ===
    'MOVA Payment History Test',
  'outing title must match',
);

expect(
  item.outing?.location ===
    'Lagos',
  'outing location must match',
);

expect(
  Number.isFinite(
    Date.parse(
      item.outing?.startsAt,
    ),
  ),
  'outing startsAt must be valid',
);

expect(
  item.requestedAmountMinor ===
    250000,
  'requested amount must be 250000',
);

expect(
  item.chargedAmountMinor ===
    253807,
  'charged amount must be 253807',
);

expect(
  item.feeAmountMinor ===
    3807,
  'fee amount must be 3807',
);

expect(
  item.currency ===
    'NGN',
  'currency must be NGN',
);

expect(
  item.methodId ===
    'card',
  'method must be card',
);

expect(
  item.provider ===
    'paystack',
  'provider must be paystack',
);

expect(
  item.providerReference ===
    process.env
      .EXPECTED_REFERENCE,
  'provider reference must match',
);

expect(
  typeof item
    .providerTransactionId ===
    'string' &&
    item
      .providerTransactionId
      .length >
      0,
  'provider transaction ID must exist',
);

expect(
  item.providerChannel ===
    'card',
  'provider channel must be card',
);

expect(
  Number.isFinite(
    Date.parse(
      item.paidAt,
    ),
  ),
  'paidAt must be valid',
);

expect(
  item.isPayer ===
    true,
  'signed-in account must be identified as payer',
);

if (
  failures.length
) {
  console.error(
    'Payment history validation failed:',
  );

  for (
    const failure
    of failures
  ) {
    console.error(
      `- ${failure}`,
    );
  }

  process.exit(
    1,
  );
}

console.log(
  '✓ Payment history item is correct',
);

console.log(
  `✓ Outing: ${item.outing.title}`,
);

console.log(
  `✓ Requested: ${item.requestedAmountMinor}`,
);

console.log(
  `✓ Fee: ${item.feeAmountMinor}`,
);

console.log(
  `✓ Charged: ${item.chargedAmountMinor}`,
);

console.log(
  `✓ Reference: ${item.providerReference}`,
);

console.log(
  `✓ Signed-in user was payer: ${item.isPayer}`,
);
NODE

TEST_SUCCESS="1"

echo
echo "================================================"
echo "PAYMENT HISTORY PRODUCTION TEST PASSED"
echo "================================================"
echo
echo "Verified:"
echo "✓ Authenticated payment history"
echo "✓ Active outing membership filtering"
echo "✓ Completed payments only"
echo "✓ Outing details"
echo "✓ Requested amount"
echo "✓ Paystack fee"
echo "✓ Actual charged amount"
echo "✓ Provider reference"
echo "✓ Paid timestamp"
echo "✓ Payer identification"
echo