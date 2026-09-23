#!/bin/bash

set -euo pipefail

API_BASE="${API_BASE:-http://localhost:4001/api/v1}"

echo
echo "MOVA payment recipients live test"
echo "API: $API_BASE"
echo
echo "Use TWO disposable, verified MOVA accounts."
echo "Passwords are entered locally and will not be printed."
echo

read -r -p "Account A email: " A_EMAIL
read -r -s -p "Account A password: " A_PASSWORD
echo

read -r -p "Account B email: " B_EMAIL
read -r -s -p "Account B password: " B_PASSWORD
echo
echo

make_login_payload() {
  EMAIL_VALUE="$1" \
  PASSWORD_VALUE="$2" \
  node -e '
    process.stdout.write(
      JSON.stringify({
        email: process.env.EMAIL_VALUE,
        password: process.env.PASSWORD_VALUE,
      }),
    );
  '
}

json_value() {
  local expression="$1"

  node -e "
    const fs = require('fs');
    const input = fs.readFileSync(0, 'utf8');

    try {
      const data = JSON.parse(input);
      const value = ${expression};

      if (
        value === undefined ||
        value === null
      ) {
        process.stdout.write('');
      } else if (
        typeof value === 'string'
      ) {
        process.stdout.write(value);
      } else {
        process.stdout.write(
          JSON.stringify(value),
        );
      }
    } catch {
      process.stdout.write('');
    }
  "
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

  curl -fsS \
    -X POST \
    "$API_BASE/auth/login" \
    -H "Content-Type: application/json" \
    -d "$payload"
}

api_get() {
  local token="$1"
  local path="$2"

  curl -fsS \
    "$API_BASE$path" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json"
}

api_post() {
  local token="$1"
  local path="$2"
  local body="$3"

  curl -fsS \
    -X POST \
    "$API_BASE$path" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -d "$body"
}

api_delete() {
  local token="$1"
  local path="$2"

  curl -fsS \
    -X DELETE \
    "$API_BASE$path" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json"
}

outgoing_request_id() {
  local target_user_id="$1"

  TARGET_USER_ID="$target_user_id" \
  node -e '
    const fs = require("fs");

    const data = JSON.parse(
      fs.readFileSync(0, "utf8"),
    );

    const request =
      (data.outgoing || []).find(
        (item) =>
          item.user &&
          item.user.id ===
            process.env.TARGET_USER_ID,
      );

    process.stdout.write(
      request?.id ?? "",
    );
  '
}

incoming_request_id() {
  local target_user_id="$1"

  TARGET_USER_ID="$target_user_id" \
  node -e '
    const fs = require("fs");

    const data = JSON.parse(
      fs.readFileSync(0, "utf8"),
    );

    const request =
      (data.incoming || []).find(
        (item) =>
          item.user &&
          item.user.id ===
            process.env.TARGET_USER_ID,
      );

    process.stdout.write(
      request?.id ?? "",
    );
  '
}

recipient_exists() {
  local target_user_id="$1"

  TARGET_USER_ID="$target_user_id" \
  node -e '
    const fs = require("fs");

    const data = JSON.parse(
      fs.readFileSync(0, "utf8"),
    );

    const exists =
      Array.isArray(data.recipients) &&
      data.recipients.some(
        (recipient) =>
          recipient.id ===
            process.env.TARGET_USER_ID,
      );

    process.exit(
      exists ? 0 : 1,
    );
  '
}

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
    json_value 'data.accessToken'
)"

A_ID="$(
  printf '%s' "$A_LOGIN" |
    json_value 'data.user?.id'
)"

B_TOKEN="$(
  printf '%s' "$B_LOGIN" |
    json_value 'data.accessToken'
)"

B_ID="$(
  printf '%s' "$B_LOGIN" |
    json_value 'data.user?.id'
)"

if [ -z "$A_TOKEN" ] || [ -z "$A_ID" ]; then
  echo "✗ Account A login response was invalid."
  exit 1
fi

if [ -z "$B_TOKEN" ] || [ -z "$B_ID" ]; then
  echo "✗ Account B login response was invalid."
  exit 1
fi

if [ "$A_ID" = "$B_ID" ]; then
  echo "✗ Account A and Account B must be different users."
  exit 1
fi

echo "✓ Both accounts logged in"
echo

echo "Cleaning any previous relationship..."

api_delete \
  "$A_TOKEN" \
  "/friends/$B_ID/block" \
  >/dev/null 2>&1 || true

api_delete \
  "$B_TOKEN" \
  "/friends/$A_ID/block" \
  >/dev/null 2>&1 || true

api_delete \
  "$A_TOKEN" \
  "/friends/$B_ID" \
  >/dev/null 2>&1 || true

api_delete \
  "$B_TOKEN" \
  "/friends/$A_ID" \
  >/dev/null 2>&1 || true

A_REQUESTS="$(
  api_get \
    "$A_TOKEN" \
    "/friends/requests"
)"

A_OUTGOING="$(
  printf '%s' "$A_REQUESTS" |
    outgoing_request_id "$B_ID"
)"

if [ -n "$A_OUTGOING" ]; then
  api_delete \
    "$A_TOKEN" \
    "/friends/requests/$A_OUTGOING" \
    >/dev/null
fi

B_REQUESTS="$(
  api_get \
    "$B_TOKEN" \
    "/friends/requests"
)"

B_OUTGOING="$(
  printf '%s' "$B_REQUESTS" |
    outgoing_request_id "$A_ID"
)"

if [ -n "$B_OUTGOING" ]; then
  api_delete \
    "$B_TOKEN" \
    "/friends/requests/$B_OUTGOING" \
    >/dev/null
fi

echo "✓ Test accounts are clean"
echo

echo "TEST 1: accepted friend becomes payment recipient"

SEND_RESULT="$(
  api_post \
    "$A_TOKEN" \
    "/friends/requests" \
    "{\"recipientId\":\"$B_ID\"}"
)"

SEND_STATUS="$(
  printf '%s' "$SEND_RESULT" |
    json_value 'data.status'
)"

if [ "$SEND_STATUS" != "sent" ]; then
  echo "✗ Friend request was not created."
  echo "$SEND_RESULT"
  exit 1
fi

B_REQUESTS="$(
  api_get \
    "$B_TOKEN" \
    "/friends/requests"
)"

REQUEST_ID="$(
  printf '%s' "$B_REQUESTS" |
    incoming_request_id "$A_ID"
)"

if [ -z "$REQUEST_ID" ]; then
  echo "✗ Account B did not receive Account A's friend request."
  exit 1
fi

ACCEPT_RESULT="$(
  api_post \
    "$B_TOKEN" \
    "/friends/requests/$REQUEST_ID/respond" \
    '{"accept":true}'
)"

ACCEPT_STATUS="$(
  printf '%s' "$ACCEPT_RESULT" |
    json_value 'data.status'
)"

if [ "$ACCEPT_STATUS" != "accepted" ]; then
  echo "✗ Friend request was not accepted."
  echo "$ACCEPT_RESULT"
  exit 1
fi

RECIPIENTS="$(
  api_get \
    "$A_TOKEN" \
    "/me/payment-recipients"
)"

if printf '%s' "$RECIPIENTS" |
  recipient_exists "$B_ID"
then
  echo "✓ Accepted friend appears as a payment recipient"
else
  echo "✗ Accepted friend was missing from payment recipients."
  echo "$RECIPIENTS"
  exit 1
fi

echo
echo "TEST 2: removed friend disappears from payment recipients"

api_delete \
  "$A_TOKEN" \
  "/friends/$B_ID" \
  >/dev/null

RECIPIENTS="$(
  api_get \
    "$A_TOKEN" \
    "/me/payment-recipients"
)"

if printf '%s' "$RECIPIENTS" |
  recipient_exists "$B_ID"
then
  echo "✗ Removed friend still appears as a payment recipient."
  exit 1
else
  echo "✓ Removed friend no longer appears as a payment recipient"
fi

echo
echo "TEST 3: blocked user cannot remain a payment recipient"

SEND_RESULT="$(
  api_post \
    "$A_TOKEN" \
    "/friends/requests" \
    "{\"recipientId\":\"$B_ID\"}"
)"

SEND_STATUS="$(
  printf '%s' "$SEND_RESULT" |
    json_value 'data.status'
)"

if [ "$SEND_STATUS" != "sent" ]; then
  echo "✗ Second friend request was not created."
  echo "$SEND_RESULT"
  exit 1
fi

B_REQUESTS="$(
  api_get \
    "$B_TOKEN" \
    "/friends/requests"
)"

REQUEST_ID="$(
  printf '%s' "$B_REQUESTS" |
    incoming_request_id "$A_ID"
)"

if [ -z "$REQUEST_ID" ]; then
  echo "✗ Second friend request was not found."
  exit 1
fi

ACCEPT_RESULT="$(
  api_post \
    "$B_TOKEN" \
    "/friends/requests/$REQUEST_ID/respond" \
    '{"accept":true}'
)"

ACCEPT_STATUS="$(
  printf '%s' "$ACCEPT_RESULT" |
    json_value 'data.status'
)"

if [ "$ACCEPT_STATUS" != "accepted" ]; then
  echo "✗ Second friend request was not accepted."
  echo "$ACCEPT_RESULT"
  exit 1
fi

api_post \
  "$A_TOKEN" \
  "/friends/$B_ID/block" \
  '{}' \
  >/dev/null

RECIPIENTS="$(
  api_get \
    "$A_TOKEN" \
    "/me/payment-recipients"
)"

if printf '%s' "$RECIPIENTS" |
  recipient_exists "$B_ID"
then
  echo "✗ Blocked user still appears as a payment recipient."
  exit 1
else
  echo "✓ Blocked user does not appear as a payment recipient"
fi

echo
echo "Cleaning up..."

api_delete \
  "$A_TOKEN" \
  "/friends/$B_ID/block" \
  >/dev/null 2>&1 || true

api_delete \
  "$B_TOKEN" \
  "/friends/$A_ID/block" \
  >/dev/null 2>&1 || true

echo "✓ Cleanup complete"

unset A_TOKEN
unset B_TOKEN
unset A_LOGIN
unset B_LOGIN

echo
echo "=========================================="
echo "ALL PAYMENT RECIPIENT LIVE TESTS PASSED"
echo "=========================================="
echo