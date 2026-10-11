import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { SupabaseService } from '../supabase/supabase.service';
import { TransferCheckoutService } from './transfer-checkout.service';

describe(
  'TransferCheckoutService',
  () => {
    let service:
      TransferCheckoutService;

    const senderId =
      '11111111-1111-4111-8111-111111111111';

    const quoteId =
      '22222222-2222-4222-8222-222222222222';

    const paymentMethodId =
      '33333333-3333-4333-8333-333333333333';

    const intentId =
      '44444444-4444-4444-8444-444444444444';

    const providerReference =
      'mova-ft-44444444444444448444444444444444';

    const rpc =
      jest.fn();

    const from =
      jest.fn();

    const originalFetch =
      global.fetch;

    let paymentMethodResult: {
      data:
        unknown;

      error:
        unknown;
    };

    function paymentMethodQuery() {
      const query = {
        select:
          jest.fn(),

        eq:
          jest.fn(),

        maybeSingle:
          jest.fn(),
      };

      query.select.mockReturnValue(
        query,
      );

      query.eq.mockReturnValue(
        query,
      );

      query.maybeSingle.mockImplementation(
        async () =>
          paymentMethodResult,
      );

      return query;
    }

    function response(
      status:
        number,

      value:
        unknown,
    ): Response {
      return {
        ok:
          status >=
            200 &&
          status <
            300,

        status,

        text:
          async () =>
            JSON.stringify(
              value,
            ),
      } as
        unknown as
        Response;
    }

    function prepareCreated() {
      return {
        data: {
          status:
            'created',

          intentId,

          amountMinor:
            250000,

          feeMinor:
            0,

          totalMinor:
            250000,

          currency:
            'NGN',

          paymentMethodId,
        },

        error:
          null,
      };
    }

    function beginReady() {
      return {
        data: {
          status:
            'ready',

          intentId,

          amountMinor:
            250000,

          feeMinor:
            0,

          totalMinor:
            250000,

          currency:
            'NGN',

          paymentMethodId,

          providerReference,
        },

        error:
          null,
      };
    }

    beforeEach(
      async () => {
        jest.resetAllMocks();

        global.fetch =
          jest.fn();

        paymentMethodResult = {
          data: {
            id:
              paymentMethodId,

            user_id:
              senderId,

            provider:
              'paystack',

            provider_email:
              'sender@example.com',

            provider_authorization_code:
              'AUTH_test',

            reusable:
              true,

            disabled_at:
              null,
          },

          error:
            null,
        };

        from.mockImplementation(
          (
            table:
              string,
          ) => {
            if (
              table !==
              'payment_methods'
            ) {
              throw new Error(
                `Unexpected table ${table}`,
              );
            }

            return paymentMethodQuery();
          },
        );

        const module =
          await Test.createTestingModule({
            providers: [
              TransferCheckoutService,

              {
                provide:
                  ConfigService,

                useValue: {
                  get:
                    jest.fn(
                      (
                        key:
                          string,
                      ) =>
                        key ===
                        'PAYSTACK_SECRET_KEY'
                          ? 'sk_test_example'
                          : undefined,
                    ),
                },
              },

              {
                provide:
                  SupabaseService,

                useValue: {
                  createAdminClient:
                    () => ({
                      rpc,
                      from,
                    }),
                },
              },
            ],
          }).compile();

        service =
          module.get(
            TransferCheckoutService,
          );
      },
    );

    afterAll(
      () => {
        global.fetch =
          originalFetch;
      },
    );

    it('starts a saved-card friend transfer and returns processing', async () => {
      rpc
        .mockResolvedValueOnce(
          prepareCreated(),
        )
        .mockResolvedValueOnce(
          beginReady(),
        );

      (
        global.fetch as
          jest.Mock
      ).mockResolvedValueOnce(
        response(
          200,
          {
            status:
              true,

            data: {
              status:
                'success',

              reference:
                providerReference,
            },
          },
        ),
      );

      await expect(
        service.checkout(
          senderId,
          quoteId,
          'transfer-checkout-12345',
        ),
      ).resolves.toEqual({
        status:
          'processing',
      });

      expect(
        rpc,
      ).toHaveBeenNthCalledWith(
        1,
        'prepare_friend_transfer_payment',
        expect.objectContaining({
          p_sender_user_id:
            senderId,

          p_quote_id:
            quoteId,

          p_idempotency_key_hash:
            expect.stringMatching(
              /^[0-9a-f]{64}$/,
            ),
        }),
      );

      expect(
        rpc,
      ).toHaveBeenNthCalledWith(
        2,
        'begin_friend_transfer_saved_card_charge',
        {
          p_sender_user_id:
            senderId,

          p_intent_id:
            intentId,

          p_provider_reference:
            providerReference,
        },
      );

      const [
        url,
        options,
      ] =
        (
          global.fetch as
            jest.Mock
        ).mock.calls[0] as [
          string,
          RequestInit,
        ];

      expect(
        url,
      ).toBe(
        'https://api.paystack.co/transaction/charge_authorization',
      );

      const body =
        JSON.parse(
          options.body as
            string,
        ) as
          Record<
            string,
            unknown
          >;

      expect(
        body,
      ).toMatchObject({
        authorization_code:
          'AUTH_test',

        email:
          'sender@example.com',

        amount:
          '250000',

        currency:
          'NGN',

        reference:
          providerReference,
      });
    });

    it('does not charge again when the idempotent payment is already processing', async () => {
      rpc.mockResolvedValueOnce({
        data: {
          status:
            'existing',

          intentId,

          paymentStatus:
            'processing',

          amountMinor:
            250000,

          feeMinor:
            0,

          totalMinor:
            250000,

          currency:
            'NGN',

          paymentMethodId,
        },

        error:
          null,
      });

      await expect(
        service.checkout(
          senderId,
          quoteId,
          'transfer-checkout-12345',
        ),
      ).resolves.toEqual({
        status:
          'processing',
      });

      expect(
        global.fetch,
      ).not.toHaveBeenCalled();

      expect(
        rpc,
      ).toHaveBeenCalledTimes(
        1,
      );
    });

    it('returns completed when the idempotent transfer payment already completed', async () => {
      rpc.mockResolvedValueOnce({
        data: {
          status:
            'existing',

          intentId,

          paymentStatus:
            'completed',
        },

        error:
          null,
      });

      await expect(
        service.checkout(
          senderId,
          quoteId,
          'transfer-checkout-12345',
        ),
      ).resolves.toEqual({
        status:
          'completed',
      });

      expect(
        global.fetch,
      ).not.toHaveBeenCalled();
    });

    it('rejects an invalid idempotency key before touching the database', async () => {
      await expect(
        service.checkout(
          senderId,
          quoteId,
          'short',
        ),
      ).rejects.toMatchObject({
        status:
          400,
      });

      expect(
        rpc,
      ).not.toHaveBeenCalled();

      expect(
        global.fetch,
      ).not.toHaveBeenCalled();
    });

    it('rejects checkout when the users are no longer friends', async () => {
      rpc.mockResolvedValueOnce({
        data: {
          status:
            'not_friends',
        },

        error:
          null,
      });

      await expect(
        service.checkout(
          senderId,
          quoteId,
          'transfer-checkout-12345',
        ),
      ).rejects.toMatchObject({
        status:
          409,

        message:
          'You can only send money to an accepted friend.',
      });

      expect(
        global.fetch,
      ).not.toHaveBeenCalled();
    });

    it('rejects checkout when the bound receiving account is unavailable', async () => {
      rpc.mockResolvedValueOnce({
        data: {
          status:
            'recipient_account_unavailable',
        },

        error:
          null,
      });

      await expect(
        service.checkout(
          senderId,
          quoteId,
          'transfer-checkout-12345',
        ),
      ).rejects.toMatchObject({
        status:
          409,
      });

      expect(
        global.fetch,
      ).not.toHaveBeenCalled();
    });

    it('fails safely when transfer payment preparation cannot be persisted', async () => {
      rpc.mockResolvedValueOnce({
        data:
          null,

        error: {
          message:
            'database unavailable',
        },
      });

      await expect(
        service.checkout(
          senderId,
          quoteId,
          'transfer-checkout-12345',
        ),
      ).rejects.toMatchObject({
        status:
          503,

        message:
          'Unable to prepare the transfer payment right now.',
      });

      expect(
        global.fetch,
      ).not.toHaveBeenCalled();
    });

    it('marks a definite provider decline as failed', async () => {
      rpc
        .mockResolvedValueOnce(
          prepareCreated(),
        )
        .mockResolvedValueOnce(
          beginReady(),
        )
        .mockResolvedValueOnce({
          data: {
            status:
              'failed',
          },

          error:
            null,
        });

      (
        global.fetch as
          jest.Mock
      ).mockResolvedValueOnce(
        response(
          200,
          {
            status:
              true,

            data: {
              status:
                'failed',

              reference:
                providerReference,
            },
          },
        ),
      );

      await expect(
        service.checkout(
          senderId,
          quoteId,
          'transfer-checkout-12345',
        ),
      ).rejects.toMatchObject({
        status:
          422,

        message:
          'The saved card charge was declined. Use another payment method or try again later.',
      });

      expect(
        rpc,
      ).toHaveBeenNthCalledWith(
        3,
        'fail_friend_transfer_payment',
        {
          p_sender_user_id:
            senderId,

          p_intent_id:
            intentId,

          p_provider_reference:
            providerReference,

          p_reason:
            'provider_declined',
        },
      );
    });

    it('leaves an uncertain provider request processing instead of charging again', async () => {
      rpc
        .mockResolvedValueOnce(
          prepareCreated(),
        )
        .mockResolvedValueOnce(
          beginReady(),
        );

      (
        global.fetch as
          jest.Mock
      ).mockRejectedValueOnce(
        new Error(
          'network disconnected',
        ),
      );

      await expect(
        service.checkout(
          senderId,
          quoteId,
          'transfer-checkout-12345',
        ),
      ).resolves.toEqual({
        status:
          'processing',
      });

      expect(
        rpc,
      ).toHaveBeenCalledTimes(
        2,
      );
    });

    it('fails the intent best-effort when the bound saved payment method disappears before Paystack is contacted', async () => {
      rpc
        .mockResolvedValueOnce(
          prepareCreated(),
        )
        .mockResolvedValueOnce(
          beginReady(),
        )
        .mockResolvedValueOnce({
          data: {
            status:
              'failed',
          },

          error:
            null,
        });

      paymentMethodResult = {
        data:
          null,

        error:
          null,
      };

      await expect(
        service.checkout(
          senderId,
          quoteId,
          'transfer-checkout-12345',
        ),
      ).rejects.toMatchObject({
        status:
          404,

        message:
          'Saved payment method not found.',
      });

      expect(
        global.fetch,
      ).not.toHaveBeenCalled();

      expect(
        rpc,
      ).toHaveBeenNthCalledWith(
        3,
        'fail_friend_transfer_payment',
        {
          p_sender_user_id:
            senderId,

          p_intent_id:
            intentId,

          p_provider_reference:
            providerReference,

          p_reason:
            'payment_method_load_failed',
        },
      );
    });
  },
);