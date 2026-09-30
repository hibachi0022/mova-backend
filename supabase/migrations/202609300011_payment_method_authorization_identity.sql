begin;

----------------------------------------------------------------------
-- SAVED PAYMENT METHOD AUTHORIZATION IDENTITY
--
-- Paystack reusable authorizations are tied to the email address used
-- when the authorization was created.
--
-- Paystack may also issue a new authorization code for the same card,
-- while the card signature remains stable.
--
-- Therefore MOVA stores:
--   - the original provider email
--   - the stable provider signature
--
-- and prevents one MOVA account from saving the same provider card
-- more than once.
----------------------------------------------------------------------

alter table public.payment_methods
  add column provider_email text;

----------------------------------------------------------------------
-- PROVIDER EMAIL VALIDATION
----------------------------------------------------------------------

alter table public.payment_methods
  add constraint payment_methods_provider_email_check
    check (
      provider_email is null
      or (
        char_length(
          provider_email
        ) between 3 and 320
        and provider_email ~
          '^[^[:space:]@]+@[^[:space:]@]+$'
      )
    );

----------------------------------------------------------------------
-- The table has only just been introduced and no payment methods can
-- yet be created by the application.
--
-- Make provider_email mandatory before enabling the backend writer.
----------------------------------------------------------------------

alter table public.payment_methods
  alter column provider_email
  set not null;

----------------------------------------------------------------------
-- CARD IDENTITY
--
-- Paystack authorization codes can change after later card use.
-- The signature identifies the underlying card consistently.
--
-- Different MOVA users may legitimately use the same card, so the
-- uniqueness boundary includes user_id.
----------------------------------------------------------------------

create unique index
  payment_methods_user_provider_signature_idx
on public.payment_methods (
  user_id,
  provider,
  provider_signature
)
where provider_signature
  is not null;

commit;