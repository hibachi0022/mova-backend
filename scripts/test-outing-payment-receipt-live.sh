#!/usr/bin/env bash

set -euo pipefail

API_BASE="${API_BASE:-https://api.vectraservices.com.ng/api/v1}"

TMP_DIR="$(mktemp -d)"

OUTING_ID=""

cleanup_temp() {
  rm -rf "$TMP_DIR"
}

trap cleanup_temp EXIT

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
echo "MOVA PAYMENT RECEIPT PRODUCTION TEST"
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
          "MOVA Receipt UI Test",

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
echo "TEST 2: Creating trusted completed test payment record"

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
      `receipt-live-${outingId}-${unique}`,
    )
    .digest(
      'hex',
    );

const providerReference =
  `MOVA-RECEIPT-${unique}`;

const providerCheckoutId =
  `receipt_${unique}`;

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
        100000,

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
        101523,

      provider_requested_amount_minor:
        100000,

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
      'Unable to create the completed test payment.',
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
  echo
  echo "The temporary outing was preserved:"
  echo "$OUTING_ID"
  exit 1
fi

echo "✓ Completed test payment created"

echo
echo "TEST 3: Production payment status"

STATUS_FILE="$TMP_DIR/status.json"

STATUS_HTTP="$(
  api_get_status \
    "$ACCESS_TOKEN" \
    "/outings/$OUTING_ID/payment" \
    "$STATUS_FILE"
)"

if [[ "$STATUS_HTTP" != "200" ]]; then
  echo "✗ Payment status request failed."
  echo "HTTP $STATUS_HTTP"
  cat "$STATUS_FILE"
  echo
  exit 1
fi

PAYMENT_STATE="$(
  cat "$STATUS_FILE" |
    json_value \
      'status'
)"

if [[ "$PAYMENT_STATE" != "completed" ]]; then
  echo "✗ Expected completed payment status."
  cat "$STATUS_FILE"
  echo
  exit 1
fi

echo "✓ Production API reports payment completed"

echo
echo "TEST 4: Production receipt endpoint"

RECEIPT_FILE="$TMP_DIR/receipt.json"

RECEIPT_HTTP="$(
  api_get_status \
    "$ACCESS_TOKEN" \
    "/outings/$OUTING_ID/payment/receipt" \
    "$RECEIPT_FILE"
)"

if [[ "$RECEIPT_HTTP" != "200" ]]; then
  echo "✗ Receipt endpoint failed."
  echo "HTTP $RECEIPT_HTTP"
  cat "$RECEIPT_FILE"
  echo
  echo "Confirm Railway is running:"
  echo "Add outing payment receipt API"
  exit 1
fi

RECEIPT_FILE_PATH="$RECEIPT_FILE" \
EXPECTED_OUTING_ID="$OUTING_ID" \
EXPECTED_PAYMENT_ID="$PAYMENT_INTENT_ID" \
EXPECTED_REFERENCE="$PROVIDER_REFERENCE" \
node <<'NODE'
const fs =
  require(
    'fs',
  );

const receipt =
  JSON.parse(
    fs.readFileSync(
      process.env
        .RECEIPT_FILE_PATH,
      'utf8',
    ),
  );

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
  receipt.status ===
    'completed',
  'status must be completed',
);

expect(
  receipt.receiptId ===
    process.env
      .EXPECTED_PAYMENT_ID,
  'receiptId must match payment intent',
);

expect(
  receipt.outing?.id ===
    process.env
      .EXPECTED_OUTING_ID,
  'outing ID must match',
);

expect(
  receipt.outing?.title ===
    'MOVA Receipt UI Test',
  'outing title must match',
);

expect(
  receipt.requestedAmountMinor ===
    100000,
  'requested amount must be 100000',
);

expect(
  receipt.chargedAmountMinor ===
    101523,
  'charged amount must be 101523',
);

expect(
  receipt.feeAmountMinor ===
    1523,
  'fee amount must be 1523',
);

expect(
  receipt.currency ===
    'NGN',
  'currency must be NGN',
);

expect(
  receipt.methodId ===
    'card',
  'method must be card',
);

expect(
  receipt.provider ===
    'paystack',
  'provider must be paystack',
);

expect(
  receipt.providerReference ===
    process.env
      .EXPECTED_REFERENCE,
  'provider reference must match',
);

expect(
  typeof receipt
    .providerTransactionId ===
    'string' &&
    receipt
      .providerTransactionId
      .length >
      0,
  'provider transaction ID is required',
);

expect(
  receipt.providerChannel ===
    'card',
  'provider channel must be card',
);

expect(
  Number.isFinite(
    Date.parse(
      receipt.paidAt,
    ),
  ),
  'paidAt must be valid',
);

expect(
  receipt.reconciliation
    ?.state ===
    'none',
  'reconciliation state must be none',
);

if (
  failures.length
) {
  console.error(
    'Receipt validation failed:',
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
  '✓ Receipt payload is correct',
);

console.log(
  `✓ Requested: ${receipt.requestedAmountMinor}`,
);

console.log(
  `✓ Fee: ${receipt.feeAmountMinor}`,
);

console.log(
  `✓ Charged: ${receipt.chargedAmountMinor}`,
);

console.log(
  `✓ Reference: ${receipt.providerReference}`,
);
NODE

echo
echo "================================================"
echo "PAYMENT RECEIPT PRODUCTION TEST PASSED"
echo "================================================"
echo
echo "Temporary outing:"
echo "$OUTING_ID"
echo
echo "IMPORTANT:"
echo "The outing has intentionally NOT been deleted."
echo
echo "Now use this same MOVA account in the mobile app."
echo "Open:"
echo
echo "Your outings"
echo "→ MOVA Receipt UI Test"
echo "→ Payment"
echo "→ View receipt"
echo
echo "Expected receipt:"
echo
echo "Requested amount: NGN 1,000.00"
echo "Paystack fee:     NGN 15.23"
echo "Total charged:    NGN 1,015.23"
echo "Method:           Card"
echo
echo "After checking the mobile receipt screen, we will delete"
echo "this temporary outing."
echo