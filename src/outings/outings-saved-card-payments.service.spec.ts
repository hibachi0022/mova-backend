import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { SupabaseService } from '../supabase/supabase.service';
import { OutingsPaymentProviderService } from './outings-payment-provider.service';
import { OutingsSavedCardPaymentsService } from './outings-saved-card-payments.service';
import {
  OutingResponse,
  OutingsService,
} from './outings.service';

type DatabaseResult = {
  data: unknown;
  error: unknown;
};

type PaymentMethodQuery = {
  select: jest.Mock;
  eq: jest.Mock;
  maybeSingle: jest.Mock;
};

describe(
  'OutingsSavedCardPaymentsService',
  () => {
    let service:
      OutingsSavedCardPaymentsService;

    const secretKey =
      'sk_test_mova_saved_card_unit_test_secret';

    const userId =
      '11111111-1111-4111-8111-111111111111';

    const outingId =
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    const memberId =
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    const intentId =
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

    const paymentMethodId =
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

    const providerReference =
      'MOVA-cccccccccccc4ccc8ccccccccccccccc';

    const rpc =
      jest.fn();

    const outingsGet =
      jest.fn();

    const providerAvailability =
      jest.fn();

    const fetchMock =
      jest.fn();

    const originalFetch =
      globalThis.fetch;

    let paymentMethodResult:
      DatabaseResult;

    const outing:
      OutingResponse = {
        id:
          outingId,

        title:
          'Dinner',

        location:
          'Lagos',

        startsAt:
          '2099-10-01T18:00:00.000Z',

        currency:
          'NGN',

        amountMinor:
          500000,

        members: [
          {
            id:
              memberId,

            displayName:
              'Samuel',

            optedIn:
              true,
          },
        ],

        selectedMemberId:
          memberId,
      };

    function createPaymentMethodQuery():
      PaymentMethodQuery {
      const query =
        {} as
          PaymentMethodQuery;

      query.select =
        jest.fn(
          () =>
            query,
        );

      query.eq =
        jest.fn(
          () =>
            query,
        );

      query.maybeSingle =
        jest.fn(
          async () =>
            paymentMethodResult,
        );

      return query;
    }

    function defaultRpc(
      name: string,
    ) {
      if (
        name ===
        'prepare_outing_saved_card_payment_intent'
      ) {
        return Promise.resolve({
          data: {
            status:
              'created',

            intentId,

            selectedMemberId:
              memberId,

            amountMinor:
              500000,

            currency:
              'NGN',

            methodId:
              'card',

            paymentMethodId,

            expiresAt:
              '2099-10-01T18:15:00.000Z',
          },

          error:
            null,
        });
      }

      if (
        name ===
        'begin_outing_saved_card_charge'
      ) {
        return Promise.resolve({
          data: {
            status:
              'ready',

            intentId,

            paymentStatus:
              'processing',

            amountMinor:
              500000,

            currency:
              'NGN',

            paymentMethodId,

            providerReference,
          },

          error:
            null,
        });
      }

      if (
        name ===
        'fail_outing_saved_card_charge'
      ) {
        return Promise.resolve({
          data: {
            status:
              'failed',

            intentId,
          },

          error:
            null,
        });
      }

      throw new Error(
        `Unexpected RPC ${name}`,
      );
    }

    function successfulCharge(
      status =
        'success',
    ) {
      fetchMock.mockResolvedValue({
        ok:
          true,

        status:
          200,

        text:
          async () =>
            JSON.stringify({
              status:
                true,

              message:
                'Charge attempted',

              data: {
                status,

                reference:
                  providerReference,
              },
            }),
      } as Response);
    }

    beforeEach(
      async () => {
        jest.resetAllMocks();

        globalThis.fetch =
          fetchMock as unknown as
            typeof fetch;

        paymentMethodResult = {
          data: {
            id:
              paymentMethodId,

            user_id:
              userId,

            provider:
              'paystack',

            provider_email:
              'samuel@example.com',

            provider_authorization_code:
              'AUTH_test_saved_card_4081',

            reusable:
              true,

            disabled_at:
              null,
          },

          error:
            null,
        };

        outingsGet.mockResolvedValue(
          outing,
        );

        providerAvailability.mockReturnValue(
          {
            available:
              true,
          },
        );

        rpc.mockImplementation(
          defaultRpc,
        );

        successfulCharge();

        const module =
          await Test.createTestingModule({
            providers: [
              OutingsSavedCardPaymentsService,

              {
                provide:
                  SupabaseService,

                useValue: {
                  createAdminClient:
                    () => ({
                      rpc,

                      from:
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

                          return createPaymentMethodQuery();
                        },
                    }),
                },
              },

              {
                provide:
                  OutingsService,

                useValue: {
                  get:
                    outingsGet,
                },
              },

              {
                provide:
                  OutingsPaymentProviderService,

                useValue: {
                  availability:
                    providerAvailability,
                },
              },

              {
                provide:
                  ConfigService,

                useValue: {
                  get: (
                    key:
                      string,
                  ) => {
                    if (
                      key ===
                      'PAYSTACK_SECRET_KEY'
                    ) {
                      return secretKey;
                    }

                    return undefined;
                  },
                },
              },
            ],
          }).compile();

        service =
          module.get(
            OutingsSavedCardPaymentsService,
          );
      },
    );

    afterAll(
      () => {
        globalThis.fetch =
          originalFetch;
      },
    );

    it('charges a trusted saved Paystack authorization without exposing it to the client response', async () => {
      await expect(
        service.charge(
          userId,
          outingId,
          {
            paymentMethodId,
          },
          'saved-card-charge-12345',
        ),
      ).resolves.toEqual({
        status:
          'processing',
      });

      expect(
        outingsGet,
      ).toHaveBeenCalledWith(
        userId,
        outingId,
      );

      expect(
        providerAvailability,
      ).toHaveBeenCalledWith(
        'card',
        'NGN',
      );

      expect(
        rpc,
      ).toHaveBeenCalledWith(
        'prepare_outing_saved_card_payment_intent',
        expect.objectContaining({
          p_user_id:
            userId,

          p_outing_id:
            outingId,

          p_payment_method_id:
            paymentMethodId,

          p_idempotency_key_hash:
            expect.stringMatching(
              /^[0-9a-f]{64}$/,
            ),
        }),
      );

      expect(
        rpc,
      ).toHaveBeenCalledWith(
        'begin_outing_saved_card_charge',
        {
          p_user_id:
            userId,

          p_intent_id:
            intentId,

          p_payment_method_id:
            paymentMethodId,

          p_provider_reference:
            providerReference,
        },
      );

      expect(
        fetchMock,
      ).toHaveBeenCalledTimes(
        1,
      );

      const [
        url,
        options,
      ] =
        fetchMock.mock
          .calls[0] as [
          string,
          RequestInit,
        ];

      expect(
        url,
      ).toBe(
        'https://api.paystack.co/transaction/charge_authorization',
      );

      expect(
        options.method,
      ).toBe(
        'POST',
      );

      if (
        typeof options.body !==
        'string'
      ) {
        throw new Error(
          'Expected Paystack request body to be JSON text.',
        );
      }

      const body =
        JSON.parse(
          options.body,
        ) as
          Record<
            string,
            unknown
          >;

      expect(
        body,
      ).toMatchObject({
        authorization_code:
          'AUTH_test_saved_card_4081',

        email:
          'samuel@example.com',

        amount:
          '500000',

        currency:
          'NGN',

        reference:
          providerReference,
      });

      expect(
        body,
      ).not.toHaveProperty(
        'userId',
      );

      expect(
        body,
      ).not.toHaveProperty(
        'paymentMethodId',
      );
    });

    it('resumes the same idempotent payment when its existing intent is still only created', async () => {
      rpc.mockImplementation(
        (
          name:
            string,
        ) => {
          if (
            name ===
            'prepare_outing_saved_card_payment_intent'
          ) {
            return Promise.resolve({
              data: {
                status:
                  'existing',

                intentId,

                paymentStatus:
                  'created',

                selectedMemberId:
                  memberId,

                amountMinor:
                  500000,

                currency:
                  'NGN',

                methodId:
                  'card',

                paymentMethodId,

                expiresAt:
                  '2099-10-01T18:15:00.000Z',
              },

              error:
                null,
            });
          }

          if (
            name ===
            'begin_outing_saved_card_charge'
          ) {
            return Promise.resolve({
              data: {
                status:
                  'ready',

                intentId,

                paymentStatus:
                  'processing',

                amountMinor:
                  500000,

                currency:
                  'NGN',

                paymentMethodId,

                providerReference,
              },

              error:
                null,
            });
          }

          throw new Error(
            `Unexpected RPC ${name}`,
          );
        },
      );

      await expect(
        service.charge(
          userId,
          outingId,
          {
            paymentMethodId,
          },
          'saved-card-resume-created-12345',
        ),
      ).resolves.toEqual({
        status:
          'processing',
      });

      expect(
        rpc,
      ).toHaveBeenCalledWith(
        'begin_outing_saved_card_charge',
        {
          p_user_id:
            userId,

          p_intent_id:
            intentId,

          p_payment_method_id:
            paymentMethodId,

          p_provider_reference:
            providerReference,
        },
      );

      expect(
        fetchMock,
      ).toHaveBeenCalledTimes(
        1,
      );
    });

    it('does not charge Paystack again when the same payment is already processing', async () => {
      rpc.mockImplementation(
        (
          name:
            string,
        ) => {
          if (
            name ===
            'prepare_outing_saved_card_payment_intent'
          ) {
            return Promise.resolve({
              data: {
                status:
                  'existing',

                intentId,

                paymentStatus:
                  'processing',

                selectedMemberId:
                  memberId,

                amountMinor:
                  500000,

                currency:
                  'NGN',

                methodId:
                  'card',

                paymentMethodId,

                provider:
                  'paystack',

                providerReference,

                expiresAt:
                  '2099-10-01T18:15:00.000Z',
              },

              error:
                null,
            });
          }

          throw new Error(
            `Unexpected RPC ${name}`,
          );
        },
      );

      await expect(
        service.charge(
          userId,
          outingId,
          {
            paymentMethodId,
          },
          'saved-card-charge-12345',
        ),
      ).resolves.toEqual({
        status:
          'processing',
      });

      expect(
        fetchMock,
      ).not.toHaveBeenCalled();

      expect(
        rpc,
      ).toHaveBeenCalledTimes(
        1,
      );
    });

    it('returns completed without contacting Paystack when the idempotent payment is already completed', async () => {
      rpc.mockImplementation(
        (
          name:
            string,
        ) => {
          if (
            name ===
            'prepare_outing_saved_card_payment_intent'
          ) {
            return Promise.resolve({
              data: {
                status:
                  'existing',

                intentId,

                paymentStatus:
                  'completed',

                amountMinor:
                  500000,

                currency:
                  'NGN',

                methodId:
                  'card',

                paymentMethodId,
              },

              error:
                null,
            });
          }

          throw new Error(
            `Unexpected RPC ${name}`,
          );
        },
      );

      await expect(
        service.charge(
          userId,
          outingId,
          {
            paymentMethodId,
          },
          'saved-card-charge-12345',
        ),
      ).resolves.toEqual({
        status:
          'completed',
      });

      expect(
        fetchMock,
      ).not.toHaveBeenCalled();
    });

    it('does not submit another provider charge when begin reports an existing processing request', async () => {
      rpc.mockImplementation(
        (
          name:
            string,
        ) => {
          if (
            name ===
            'prepare_outing_saved_card_payment_intent'
          ) {
            return Promise.resolve({
              data: {
                status:
                  'created',

                intentId,

                amountMinor:
                  500000,

                currency:
                  'NGN',

                paymentMethodId,
              },

              error:
                null,
            });
          }

          if (
            name ===
            'begin_outing_saved_card_charge'
          ) {
            return Promise.resolve({
              data: {
                status:
                  'existing',

                intentId,

                paymentStatus:
                  'processing',

                amountMinor:
                  500000,

                currency:
                  'NGN',

                paymentMethodId,

                providerReference,
              },

              error:
                null,
            });
          }

          throw new Error(
            `Unexpected RPC ${name}`,
          );
        },
      );

      await expect(
        service.charge(
          userId,
          outingId,
          {
            paymentMethodId,
          },
          'saved-card-charge-12345',
        ),
      ).resolves.toEqual({
        status:
          'processing',
      });

      expect(
        fetchMock,
      ).not.toHaveBeenCalled();
    });

    it('marks a definitively declined provider charge failed', async () => {
      successfulCharge(
        'failed',
      );

      await expect(
        service.charge(
          userId,
          outingId,
          {
            paymentMethodId,
          },
          'saved-card-decline-12345',
        ),
      ).rejects.toMatchObject({
        status:
          422,

        message:
          'The saved card charge was declined. Use another payment method or try again later.',
      });

      expect(
        rpc,
      ).toHaveBeenCalledWith(
        'fail_outing_saved_card_charge',
        {
          p_user_id:
            userId,

          p_intent_id:
            intentId,

          p_provider_reference:
            providerReference,
        },
      );
    });

    it('keeps an uncertain provider request processing instead of risking a duplicate charge', async () => {
      fetchMock.mockRejectedValue(
        new Error(
          'network connection lost',
        ),
      );

      await expect(
        service.charge(
          userId,
          outingId,
          {
            paymentMethodId,
          },
          'saved-card-uncertain-12345',
        ),
      ).resolves.toEqual({
        status:
          'processing',
      });

      expect(
        fetchMock,
      ).toHaveBeenCalledTimes(
        1,
      );

      const failCalls =
        rpc.mock.calls.filter(
          (
            call,
          ) =>
            call[0] ===
            'fail_outing_saved_card_charge',
        );

      expect(
        failCalls,
      ).toHaveLength(
        0,
      );
    });

    it('does not contact Paystack when the saved payment method does not belong to the payer', async () => {
      rpc.mockImplementation(
        (
          name:
            string,
        ) => {
          if (
            name ===
            'prepare_outing_saved_card_payment_intent'
          ) {
            return Promise.resolve({
              data: {
                status:
                  'payment_method_not_found',
              },

              error:
                null,
            });
          }

          throw new Error(
            `Unexpected RPC ${name}`,
          );
        },
      );

      await expect(
        service.charge(
          userId,
          outingId,
          {
            paymentMethodId,
          },
          'saved-card-missing-12345',
        ),
      ).rejects.toMatchObject({
        status:
          404,

        message:
          'Saved payment method not found.',
      });

      expect(
        fetchMock,
      ).not.toHaveBeenCalled();
    });

    it('does not contact Paystack for an expired saved card', async () => {
      rpc.mockImplementation(
        (
          name:
            string,
        ) => {
          if (
            name ===
            'prepare_outing_saved_card_payment_intent'
          ) {
            return Promise.resolve({
              data: {
                status:
                  'payment_method_expired',
              },

              error:
                null,
            });
          }

          throw new Error(
            `Unexpected RPC ${name}`,
          );
        },
      );

      await expect(
        service.charge(
          userId,
          outingId,
          {
            paymentMethodId,
          },
          'saved-card-expired-12345',
        ),
      ).rejects.toMatchObject({
        status:
          409,

        message:
          'This saved card has expired. Use another payment method.',
      });

      expect(
        fetchMock,
      ).not.toHaveBeenCalled();
    });

    it('rejects an invalid idempotency key before creating a payment intent', async () => {
      await expect(
        service.charge(
          userId,
          outingId,
          {
            paymentMethodId,
          },
          'bad',
        ),
      ).rejects.toMatchObject({
        status:
          400,

        message:
          'A valid Idempotency-Key header is required.',
      });

      expect(
        outingsGet,
      ).not.toHaveBeenCalled();

      expect(
        rpc,
      ).not.toHaveBeenCalled();

      expect(
        fetchMock,
      ).not.toHaveBeenCalled();
    });

    it('fails safely before contacting Paystack when sensitive saved-card data cannot be loaded', async () => {
      paymentMethodResult = {
        data:
          null,

        error: {
          message:
            'database unavailable',
        },
      };

      await expect(
        service.charge(
          userId,
          outingId,
          {
            paymentMethodId,
          },
          'saved-card-db-failure-12345',
        ),
      ).rejects.toMatchObject({
        status:
          503,

        message:
          'Unable to load the saved payment method right now.',
      });

      expect(
        fetchMock,
      ).not.toHaveBeenCalled();

      expect(
        rpc,
      ).toHaveBeenCalledWith(
        'fail_outing_saved_card_charge',
        {
          p_user_id:
            userId,

          p_intent_id:
            intentId,

          p_provider_reference:
            providerReference,
        },
      );
    });
  },
);