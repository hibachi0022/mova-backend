begin;

do $$
declare
  test_users uuid[];

  user_a uuid;
  user_b uuid;

  result jsonb;

  request_id uuid;
  second_request_id uuid;

  saved_count integer;
  lower_user uuid;
  upper_user uuid;
begin
  --------------------------------------------------------------------
  -- TEST USERS
  --
  -- Use two existing profiles only for the duration of this transaction.
  -- Every mutation below is rolled back at the end of the script.
  --------------------------------------------------------------------

  select array_agg(user_id order by user_id)
  into test_users
  from (
    select user_id
    from public.profiles
    order by user_id
    limit 2
  ) as selected_profiles;

  if coalesce(
    array_length(test_users, 1),
    0
  ) < 2 then
    raise exception
      'FAIL: Friends tests require at least two existing profiles';
  end if;

  user_a := test_users[1];
  user_b := test_users[2];

  lower_user :=
    least(
      user_a,
      user_b
    );

  upper_user :=
    greatest(
      user_a,
      user_b
    );

  --------------------------------------------------------------------
  -- Put this pair into a clean temporary state.
  --
  -- ROLLBACK restores whatever relationship they had before the test.
  --------------------------------------------------------------------

  delete
  from public.friend_requests
  where (
    sender_id = user_a
    and recipient_id = user_b
  )
  or (
    sender_id = user_b
    and recipient_id = user_a
  );

  delete
  from public.friendships
  where user_a_id = lower_user
    and user_b_id = upper_user;

  delete
  from public.user_blocks
  where (
    blocker_id = user_a
    and blocked_id = user_b
  )
  or (
    blocker_id = user_b
    and blocked_id = user_a
  );

  --------------------------------------------------------------------
  -- 1. A USER CANNOT FRIEND THEMSELVES
  --------------------------------------------------------------------

  result :=
    public.send_friend_request(
      user_a,
      user_a
    );

  if result->>'status'
      is distinct from 'invalid' then
    raise exception
      'FAIL: self friend request should be invalid';
  end if;

  --------------------------------------------------------------------
  -- 2. USER A CAN SEND USER B A REQUEST
  --------------------------------------------------------------------

  result :=
    public.send_friend_request(
      user_a,
      user_b
    );

  if result->>'status'
      is distinct from 'sent' then
    raise exception
      'FAIL: first friend request should be sent';
  end if;

  if result->>'requestId'
      is null then
    raise exception
      'FAIL: sent friend request did not return requestId';
  end if;

  request_id :=
    (result->>'requestId')::uuid;

  select count(*)
  into saved_count
  from public.friend_requests
  where id = request_id
    and sender_id = user_a
    and recipient_id = user_b;

  if saved_count <> 1 then
    raise exception
      'FAIL: friend request row was not created correctly';
  end if;

  --------------------------------------------------------------------
  -- 3. DUPLICATE SAME-DIRECTION REQUEST DOES NOT CREATE ANOTHER ROW
  --------------------------------------------------------------------

  result :=
    public.send_friend_request(
      user_a,
      user_b
    );

  if result->>'status'
      is distinct from 'pending' then
    raise exception
      'FAIL: duplicate friend request should report pending';
  end if;

  select count(*)
  into saved_count
  from public.friend_requests
  where least(
    sender_id,
    recipient_id
  ) = lower_user
    and greatest(
      sender_id,
      recipient_id
    ) = upper_user;

  if saved_count <> 1 then
    raise exception
      'FAIL: duplicate request created more than one row';
  end if;

  --------------------------------------------------------------------
  -- 4. REVERSE-DIRECTION REQUEST ALSO DOES NOT CREATE ANOTHER ROW
  --------------------------------------------------------------------

  result :=
    public.send_friend_request(
      user_b,
      user_a
    );

  if result->>'status'
      is distinct from 'pending' then
    raise exception
      'FAIL: reverse duplicate request should report pending';
  end if;

  select count(*)
  into saved_count
  from public.friend_requests
  where least(
    sender_id,
    recipient_id
  ) = lower_user
    and greatest(
      sender_id,
      recipient_id
    ) = upper_user;

  if saved_count <> 1 then
    raise exception
      'FAIL: reverse request created a duplicate pending row';
  end if;

  --------------------------------------------------------------------
  -- 5. THE SENDER CANNOT ACCEPT THEIR OWN OUTGOING REQUEST
  --------------------------------------------------------------------

  result :=
    public.respond_friend_request(
      request_id,
      user_a,
      true
    );

  if result->>'status'
      is distinct from 'forbidden' then
    raise exception
      'FAIL: sender should not be allowed to accept their own request';
  end if;

  select count(*)
  into saved_count
  from public.friend_requests
  where id = request_id;

  if saved_count <> 1 then
    raise exception
      'FAIL: forbidden acceptance modified the pending request';
  end if;

  --------------------------------------------------------------------
  -- 6. THE RECIPIENT CAN ACCEPT
  --------------------------------------------------------------------

  result :=
    public.respond_friend_request(
      request_id,
      user_b,
      true
    );

  if result->>'status'
      is distinct from 'accepted' then
    raise exception
      'FAIL: recipient should be able to accept friend request';
  end if;

  select count(*)
  into saved_count
  from public.friend_requests
  where id = request_id;

  if saved_count <> 0 then
    raise exception
      'FAIL: accepted request should be removed';
  end if;

  select count(*)
  into saved_count
  from public.friendships
  where user_a_id = lower_user
    and user_b_id = upper_user;

  if saved_count <> 1 then
    raise exception
      'FAIL: accepted request should create exactly one friendship';
  end if;

  --------------------------------------------------------------------
  -- 7. EXISTING FRIENDS CANNOT CREATE ANOTHER REQUEST
  --------------------------------------------------------------------

  result :=
    public.send_friend_request(
      user_a,
      user_b
    );

  if result->>'status'
      is distinct from 'already_friends' then
    raise exception
      'FAIL: existing friendship should block another request';
  end if;

  result :=
    public.send_friend_request(
      user_b,
      user_a
    );

  if result->>'status'
      is distinct from 'already_friends' then
    raise exception
      'FAIL: friendship must be symmetric when checking new requests';
  end if;

  --------------------------------------------------------------------
  -- 8. EITHER FRIEND CAN REMOVE THE FRIENDSHIP
  --------------------------------------------------------------------

  if public.remove_friend(
    user_b,
    user_a
  ) is distinct from true then
    raise exception
      'FAIL: existing friendship should be removable';
  end if;

  select count(*)
  into saved_count
  from public.friendships
  where user_a_id = lower_user
    and user_b_id = upper_user;

  if saved_count <> 0 then
    raise exception
      'FAIL: friendship row remained after removal';
  end if;

  if public.remove_friend(
    user_a,
    user_b
  ) is distinct from false then
    raise exception
      'FAIL: removing a nonexistent friendship should return false';
  end if;

  --------------------------------------------------------------------
  -- 9. RECIPIENT CAN DECLINE
  --------------------------------------------------------------------

  result :=
    public.send_friend_request(
      user_a,
      user_b
    );

  if result->>'status'
      is distinct from 'sent' then
    raise exception
      'FAIL: decline test request was not created';
  end if;

  request_id :=
    (result->>'requestId')::uuid;

  result :=
    public.respond_friend_request(
      request_id,
      user_b,
      false
    );

  if result->>'status'
      is distinct from 'declined' then
    raise exception
      'FAIL: recipient should be able to decline request';
  end if;

  select count(*)
  into saved_count
  from public.friend_requests
  where id = request_id;

  if saved_count <> 0 then
    raise exception
      'FAIL: declined request should be removed';
  end if;

  select count(*)
  into saved_count
  from public.friendships
  where user_a_id = lower_user
    and user_b_id = upper_user;

  if saved_count <> 0 then
    raise exception
      'FAIL: declined request must not create friendship';
  end if;

  --------------------------------------------------------------------
  -- 10. ONLY THE SENDER CAN CANCEL A PENDING REQUEST
  --------------------------------------------------------------------

  result :=
    public.send_friend_request(
      user_a,
      user_b
    );

  if result->>'status'
      is distinct from 'sent' then
    raise exception
      'FAIL: cancellation test request was not created';
  end if;

  request_id :=
    (result->>'requestId')::uuid;

  if public.cancel_friend_request(
    request_id,
    user_b
  ) is distinct from false then
    raise exception
      'FAIL: recipient must not cancel sender request';
  end if;

  if public.cancel_friend_request(
    request_id,
    user_a
  ) is distinct from true then
    raise exception
      'FAIL: sender should be able to cancel outgoing request';
  end if;

  select count(*)
  into saved_count
  from public.friend_requests
  where id = request_id;

  if saved_count <> 0 then
    raise exception
      'FAIL: cancelled friend request still exists';
  end if;

  --------------------------------------------------------------------
  -- 11. BLOCKING REMOVES A PENDING REQUEST
  --------------------------------------------------------------------

  result :=
    public.send_friend_request(
      user_a,
      user_b
    );

  if result->>'status'
      is distinct from 'sent' then
    raise exception
      'FAIL: block-pending test request was not created';
  end if;

  second_request_id :=
    (result->>'requestId')::uuid;

  if public.block_user(
    user_b,
    user_a
  ) is distinct from true then
    raise exception
      'FAIL: valid block should succeed';
  end if;

  select count(*)
  into saved_count
  from public.friend_requests
  where id = second_request_id;

  if saved_count <> 0 then
    raise exception
      'FAIL: blocking should remove pending requests between the pair';
  end if;

  select count(*)
  into saved_count
  from public.user_blocks
  where blocker_id = user_b
    and blocked_id = user_a;

  if saved_count <> 1 then
    raise exception
      'FAIL: block row was not created';
  end if;

  --------------------------------------------------------------------
  -- 12. EITHER BLOCKING DIRECTION PREVENTS NEW REQUESTS
  --------------------------------------------------------------------

  result :=
    public.send_friend_request(
      user_a,
      user_b
    );

  if result->>'status'
      is distinct from 'blocked' then
    raise exception
      'FAIL: blocked user should not send friend request to blocker';
  end if;

  result :=
    public.send_friend_request(
      user_b,
      user_a
    );

  if result->>'status'
      is distinct from 'blocked' then
    raise exception
      'FAIL: blocker should not send friend request while block exists';
  end if;

  --------------------------------------------------------------------
  -- 13. SELF-BLOCKING IS INVALID
  --------------------------------------------------------------------

  if public.block_user(
    user_a,
    user_a
  ) is distinct from false then
    raise exception
      'FAIL: user must not be able to block themselves';
  end if;

  --------------------------------------------------------------------
  -- 14. UNBLOCK RESTORES FRIEND-REQUEST ELIGIBILITY
  --------------------------------------------------------------------

  if public.unblock_user(
    user_b,
    user_a
  ) is distinct from true then
    raise exception
      'FAIL: existing block should be removable';
  end if;

  if public.unblock_user(
    user_b,
    user_a
  ) is distinct from false then
    raise exception
      'FAIL: removing nonexistent block should return false';
  end if;

  result :=
    public.send_friend_request(
      user_b,
      user_a
    );

  if result->>'status'
      is distinct from 'sent' then
    raise exception
      'FAIL: unblocked users should be able to send requests again';
  end if;

  request_id :=
    (result->>'requestId')::uuid;

  if public.cancel_friend_request(
    request_id,
    user_b
  ) is distinct from true then
    raise exception
      'FAIL: cleanup cancellation after unblock failed';
  end if;

  --------------------------------------------------------------------
  -- 15. BLOCKING ALSO REMOVES AN EXISTING FRIENDSHIP
  --------------------------------------------------------------------

  result :=
    public.send_friend_request(
      user_a,
      user_b
    );

  if result->>'status'
      is distinct from 'sent' then
    raise exception
      'FAIL: friendship/block test request was not created';
  end if;

  request_id :=
    (result->>'requestId')::uuid;

  result :=
    public.respond_friend_request(
      request_id,
      user_b,
      true
    );

  if result->>'status'
      is distinct from 'accepted' then
    raise exception
      'FAIL: friendship/block test request was not accepted';
  end if;

  select count(*)
  into saved_count
  from public.friendships
  where user_a_id = lower_user
    and user_b_id = upper_user;

  if saved_count <> 1 then
    raise exception
      'FAIL: friendship was not created before block test';
  end if;

  if public.block_user(
    user_a,
    user_b
  ) is distinct from true then
    raise exception
      'FAIL: blocking an existing friend should succeed';
  end if;

  select count(*)
  into saved_count
  from public.friendships
  where user_a_id = lower_user
    and user_b_id = upper_user;

  if saved_count <> 0 then
    raise exception
      'FAIL: blocking should remove existing friendship';
  end if;

  select count(*)
  into saved_count
  from public.user_blocks
  where blocker_id = user_a
    and blocked_id = user_b;

  if saved_count <> 1 then
    raise exception
      'FAIL: block was not persisted after friendship removal';
  end if;

  --------------------------------------------------------------------
  -- 16. BLOCKED FRIEND REQUEST RESPONSE CANNOT CREATE FRIENDSHIP
  --------------------------------------------------------------------

  if public.unblock_user(
    user_a,
    user_b
  ) is distinct from true then
    raise exception
      'FAIL: block cleanup before response test failed';
  end if;

  result :=
    public.send_friend_request(
      user_a,
      user_b
    );

  if result->>'status'
      is distinct from 'sent' then
    raise exception
      'FAIL: blocked-response test request was not created';
  end if;

  request_id :=
    (result->>'requestId')::uuid;

  /*
   * Simulate a block occurring before the recipient responds.
   */
  insert into public.user_blocks (
    blocker_id,
    blocked_id
  )
  values (
    user_b,
    user_a
  );

  result :=
    public.respond_friend_request(
      request_id,
      user_b,
      true
    );

  if result->>'status'
      is distinct from 'blocked' then
    raise exception
      'FAIL: blocked request response should not create friendship';
  end if;

  select count(*)
  into saved_count
  from public.friendships
  where user_a_id = lower_user
    and user_b_id = upper_user;

  if saved_count <> 0 then
    raise exception
      'FAIL: blocked request response created friendship';
  end if;

  select count(*)
  into saved_count
  from public.friend_requests
  where id = request_id;

  if saved_count <> 0 then
    raise exception
      'FAIL: blocked request should be removed when responding';
  end if;

  delete
  from public.user_blocks
  where blocker_id = user_b
    and blocked_id = user_a;

  --------------------------------------------------------------------
  -- 17. INVALID REQUEST IDS ARE HANDLED SAFELY
  --------------------------------------------------------------------

  result :=
    public.respond_friend_request(
      gen_random_uuid(),
      user_b,
      true
    );

  if result->>'status'
      is distinct from 'invalid' then
    raise exception
      'FAIL: unknown request ID should return invalid';
  end if;

  if public.cancel_friend_request(
    gen_random_uuid(),
    user_a
  ) is distinct from false then
    raise exception
      'FAIL: cancelling unknown request should return false';
  end if;

  --------------------------------------------------------------------
  -- 18. ANON/AUTHENTICATED ROLES MUST NOT EXECUTE FRIEND RPCS
  --------------------------------------------------------------------

  if
    has_function_privilege(
      'anon',
      'public.send_friend_request(uuid,uuid)',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'public.send_friend_request(uuid,uuid)',
      'EXECUTE'
    )

    or has_function_privilege(
      'anon',
      'public.respond_friend_request(uuid,uuid,boolean)',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'public.respond_friend_request(uuid,uuid,boolean)',
      'EXECUTE'
    )

    or has_function_privilege(
      'anon',
      'public.cancel_friend_request(uuid,uuid)',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'public.cancel_friend_request(uuid,uuid)',
      'EXECUTE'
    )

    or has_function_privilege(
      'anon',
      'public.remove_friend(uuid,uuid)',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'public.remove_friend(uuid,uuid)',
      'EXECUTE'
    )

    or has_function_privilege(
      'anon',
      'public.block_user(uuid,uuid)',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'public.block_user(uuid,uuid)',
      'EXECUTE'
    )

    or has_function_privilege(
      'anon',
      'public.unblock_user(uuid,uuid)',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'public.unblock_user(uuid,uuid)',
      'EXECUTE'
    )
  then
    raise exception
      'FAIL: client roles can execute friends RPC functions';
  end if;

  --------------------------------------------------------------------
  -- 19. CLIENT ROLES MUST NOT HAVE DIRECT TABLE ACCESS
  --------------------------------------------------------------------

  if
    has_table_privilege(
      'anon',
      'public.friend_requests',
      'SELECT'
    )
    or has_table_privilege(
      'authenticated',
      'public.friend_requests',
      'SELECT'
    )

    or has_table_privilege(
      'anon',
      'public.friendships',
      'SELECT'
    )
    or has_table_privilege(
      'authenticated',
      'public.friendships',
      'SELECT'
    )

    or has_table_privilege(
      'anon',
      'public.user_blocks',
      'SELECT'
    )
    or has_table_privilege(
      'authenticated',
      'public.user_blocks',
      'SELECT'
    )
  then
    raise exception
      'FAIL: client roles have direct friends-table access';
  end if;
end;
$$;

select
  'PASS: friends database checks completed' as result;

rollback;