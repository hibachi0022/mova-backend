import { Test } from '@nestjs/testing';
import { SupabaseService } from '../supabase/supabase.service';
import { OutingsPaymentProviderService } from './outings-payment-provider.service';
import { OutingsPaymentsService } from './outings-payments.service';
import {
  OutingResponse,
  OutingsService,
} from './outings.service';

type DatabaseResult = {
  data: unknown;
  error: unknown;
};

type QueryStub = {
  select: jest.Mock;
  eq: jest.Mock;
  order: jest.Mock;
  limit: jest.Mock;
  is: jest.Mock;
  maybeSingle: jest.Mock;
};

describe(
  'OutingsPaymentsService',
  () => {
    let service:
      OutingsPaymentsService;

    let paymentResponses:
      DatabaseResult[];

    const rpc =
      jest.fn();

    const providerChoices =
      jest.fn();

    const providerAvailability =
      jest.fn();

    const initializeCheckout =
      jest.fn();

    const outingsGet =
      jest.fn();

    const userId =
      '11111111-1111-4111-8111-111111111111';

    const otherUserId =
      '22222222-2222-4222-8222-222222222222';

    const outingId =
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    const memberId =
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    const intentId =
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

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

    function createPaymentQuery():
      QueryStub {
      const query =
        {} as QueryStub;

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

      query.order =
        jest.fn(
          () =>
            query,
        );

      query.limit =
        jest.fn(
          () =>
            query,
        );

      query.is =
        jest.fn(
          () =>
            query,
        );

      query.maybeSingle =
        jest.fn(
          async () =>
            paymentResponses.shift() ??
            {
              data:
                null,

              error:
                null,
            },
        );

      return query;
    }

    function createMemberQuery():
      QueryStub {
      const query =
        {} as QueryStub;

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

      query.order =
        jest.fn(
          () =>
            query,
        );

      query.limit =
        jest.fn(
          () =>
            query,
        );

      query.is =
        jest.fn(
          () =>
            query,
        );

      query.maybeSingle =
        jest.fn(
          async () => ({
            data: {
              user_id:
                userId,
            },

            error:
              null,
          }),
        );

      return query;
    }

    beforeEach(
      async () => {
        jest.resetAllMocks();

        paymentResponses =
          [];

        outingsGet.mockResolvedValue(
          outing,
        );

        providerAvailability.mockReturnValue(
          {
            available:
              true,
          },
        );

        providerChoices.mockReturnValue(
          {
            methods: [
              {
                id:
                  'card',

                label:
                  'Card',

                available:
                  true,
              },
            ],
          },
        );

        initializeCheckout.mockResolvedValue(
          {
            provider:
              'paystack',

            providerCheckoutId:
              'access_123',

            providerReference:
              'MOVA-reference',

            checkoutUrl:
              'https://checkout.paystack.com/test',

            expiresAt:
              '2099-10-01T18:15:00.000Z',
          },
        );

        const module =
          await Test.createTestingModule(
            {
              providers: [
                OutingsPaymentsService,

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
                              table ===
                              'outing_payment_intents'
                            ) {
                              return createPaymentQuery();
                            }

                            if (
                              table ===
                              'outing_members'
                            ) {
                              return createMemberQuery();
                            }

                            throw new Error(
                              `Unexpected table ${table}`,
                            );
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
                    choices:
                      providerChoices,

                    availability:
                      providerAvailability,

                    initializeCheckout,
                  },
                },
              ],
            },
          ).compile();

        service =
          module.get(
            OutingsPaymentsService,
          );
      },
    );

    it('returns provider choices for a member outing', async () => {
      const result =
        await service.options(
          userId,
          outingId,
        );

      expect(
        outingsGet,
      ).toHaveBeenCalledWith(
        userId,
        outingId,
      );

      expect(
        providerChoices,
      ).toHaveBeenCalledWith({
        currency:
          'NGN',

        amountMinor:
          500000,

        hasSelectedPayer:
          true,
      });

      expect(
        result,
      ).toEqual({
        methods: [
          {
            id:
              'card',

            label:
              'Card',

            available:
              true,
          },
        ],
      });
    });

    it('returns unpaid when no payment attempt exists', async () => {
      await expect(
        service.status(
          userId,
          outingId,
        ),
      ).resolves.toEqual({
        status:
          'unpaid',

        amountMinor:
          500000,

        currency:
          'NGN',

        isPayer:
          true,
      });
    });

    it('returns reconciliation_required before normal payment states', async () => {
      paymentResponses.push({
        data: {
          id:
            intentId,

          status:
            'expired',

          payer_user_id:
            userId,

          amount_minor:
            500000,

          currency:
            'NGN',

          method_id:
            'card',

          checkout_url:
            null,

          expires_at:
            '2099-10-01T18:15:00.000Z',

          completed_at:
            null,

          provider_paid_at:
            '2026-09-29T20:00:00.000Z',

          provider_amount_minor:
            500000,

          provider_currency:
            'NGN',

          reconciliation_state:
            'required',

          reconciliation_reason:
            'late_success_expired',

          reconciliation_required_at:
            '2026-09-29T20:01:00.000Z',

          reconciliation_resolution:
            null,

          created_at:
            '2026-09-29T19:45:00.000Z',
        },

        error:
          null,
      });

      await expect(
        service.status(
          userId,
          outingId,
        ),
      ).resolves.toEqual({
        status:
          'reconciliation_required',

        amountMinor:
          500000,

        currency:
          'NGN',

        methodId:
          'card',

        paidAt:
          '2026-09-29T20:00:00.000Z',

        reconciliationReason:
          'late_success_expired',

        isPayer:
          true,
      });
    });

    it('returns a completed payment as the trusted final state', async () => {
      paymentResponses.push(
        {
          data:
            null,

          error:
            null,
        },

        {
          data: {
            id:
              intentId,

            status:
              'completed',

            payer_user_id:
              userId,

            amount_minor:
              500000,

            currency:
              'NGN',

            method_id:
              'card',

            checkout_url:
              null,

            expires_at:
              '2099-10-01T18:15:00.000Z',

            completed_at:
              '2026-09-29T12:00:00.000Z',

            provider_paid_at:
              '2026-09-29T11:59:58.000Z',

            provider_amount_minor:
              500000,

            provider_currency:
              'NGN',

            reconciliation_state:
              'none',

            reconciliation_reason:
              null,

            reconciliation_required_at:
              null,

            reconciliation_resolution:
              null,

            created_at:
              '2026-09-29T11:55:00.000Z',
          },

          error:
            null,
        },
      );

      await expect(
        service.status(
          userId,
          outingId,
        ),
      ).resolves.toEqual({
        status:
          'completed',

        amountMinor:
          500000,

        currency:
          'NGN',

        methodId:
          'card',

        paidAt:
          '2026-09-29T11:59:58.000Z',

        isPayer:
          true,
      });
    });

    it('blocks checkout while reconciliation is required', async () => {
      paymentResponses.push({
        data: {
          id:
            intentId,
        },

        error:
          null,
      });

      await expect(
        service.checkout(
          userId,
          'samuel@example.com',
          outingId,
          {
            methodId:
              'card',
          },
          'checkout-key-12345',
        ),
      ).rejects.toMatchObject({
        status:
          409,

        message:
          'This outing has a payment that requires review before another payment can be started.',
      });

      expect(
        rpc,
      ).not.toHaveBeenCalled();

      expect(
        initializeCheckout,
      ).not.toHaveBeenCalled();
    });

    it('maps the database reconciliation race guard to 409', async () => {
      rpc.mockResolvedValue({
        data:
          null,

        error: {
          message:
            'OUTING_PAYMENT_RECONCILIATION_REQUIRED',
        },
      });

      await expect(
        service.checkout(
          userId,
          'samuel@example.com',
          outingId,
          {
            methodId:
              'card',
          },
          'checkout-key-12345',
        ),
      ).rejects.toMatchObject({
        status:
          409,

        message:
          'This outing has a payment that requires review before another payment can be started.',
      });

      expect(
        initializeCheckout,
      ).not.toHaveBeenCalled();
    });

    it('creates and attaches provider checkout', async () => {
      rpc.mockImplementation(
        (
          name: string,
        ) => {
          if (
            name ===
            'prepare_outing_payment_intent'
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

                expiresAt:
                  '2099-10-01T18:15:00.000Z',
              },

              error:
                null,
            });
          }

          if (
            name ===
            'attach_outing_payment_checkout'
          ) {
            return Promise.resolve({
              data: {
                status:
                  'ready',

                intentId,

                checkoutUrl:
                  'https://checkout.paystack.com/test',

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
        service.checkout(
          userId,
          'samuel@example.com',
          outingId,
          {
            methodId:
              'card',
          },
          'checkout-key-12345',
        ),
      ).resolves.toEqual({
        checkoutUrl:
          'https://checkout.paystack.com/test',
      });

      expect(
        initializeCheckout,
      ).toHaveBeenCalledWith({
        intentId,

        outingId,

        email:
          'samuel@example.com',

        amountMinor:
          500000,

        currency:
          'NGN',

        methodId:
          'card',

        expiresAt:
          '2099-10-01T18:15:00.000Z',
      });
    });

    it('reuses an existing checkout-ready URL', async () => {
      rpc.mockResolvedValue({
        data: {
          status:
            'existing',

          intentId,

          paymentStatus:
            'checkout_ready',

          selectedMemberId:
            memberId,

          amountMinor:
            500000,

          currency:
            'NGN',

          methodId:
            'card',

          expiresAt:
            '2099-10-01T18:15:00.000Z',
        },

        error:
          null,
      });

      paymentResponses.push(
        {
          data:
            null,

          error:
            null,
        },

        {
          data: {
            id:
              intentId,

            status:
              'checkout_ready',

            payer_user_id:
              userId,

            amount_minor:
              500000,

            currency:
              'NGN',

            method_id:
              'card',

            checkout_url:
              'https://checkout.paystack.com/existing',

            expires_at:
              '2099-10-01T18:15:00.000Z',

            completed_at:
              null,

            provider_paid_at:
              null,

            provider_amount_minor:
              null,

            provider_currency:
              null,

            reconciliation_state:
              'none',

            reconciliation_reason:
              null,

            reconciliation_required_at:
              null,

            reconciliation_resolution:
              null,

            created_at:
              '2099-10-01T18:00:00.000Z',
          },

          error:
            null,
        },
      );

      await expect(
        service.checkout(
          userId,
          'samuel@example.com',
          outingId,
          {
            methodId:
              'card',
          },
          'checkout-key-12345',
        ),
      ).resolves.toEqual({
        checkoutUrl:
          'https://checkout.paystack.com/existing',
      });

      expect(
        initializeCheckout,
      ).not.toHaveBeenCalled();
    });

    it('prevents a member who was not selected from paying', async () => {
      rpc.mockResolvedValue({
        data: {
          status:
            'not_selected_payer',
        },

        error:
          null,
      });

      await expect(
        service.checkout(
          otherUserId,
          'other@example.com',
          outingId,
          {
            methodId:
              'card',
          },
          'checkout-key-12345',
        ),
      ).rejects.toMatchObject({
        status:
          403,

        message:
          'Only the selected payer can start this payment.',
      });
    });

    it('rejects idempotency-key conflicts', async () => {
      rpc.mockResolvedValue({
        data: {
          status:
            'idempotency_conflict',
        },

        error:
          null,
      });

      await expect(
        service.checkout(
          userId,
          'samuel@example.com',
          outingId,
          {
            methodId:
              'card',
          },
          'checkout-key-12345',
        ),
      ).rejects.toMatchObject({
        status:
          409,
      });
    });

    it('rejects unavailable payment methods before creating an intent', async () => {
      providerAvailability.mockReturnValue({
        available:
          false,

        reason:
          'PayPal is not connected to the current payment provider yet.',
      });

      await expect(
        service.checkout(
          userId,
          'samuel@example.com',
          outingId,
          {
            methodId:
              'paypal',
          },
          'checkout-key-12345',
        ),
      ).rejects.toMatchObject({
        status:
          422,
      });

      expect(
        rpc,
      ).not.toHaveBeenCalled();
    });

    it('requires an idempotency key', async () => {
      await expect(
        service.checkout(
          userId,
          'samuel@example.com',
          outingId,
          {
            methodId:
              'card',
          },
          undefined,
        ),
      ).rejects.toMatchObject({
        status:
          400,

        message:
          'A valid Idempotency-Key header is required.',
      });
    });
  },
);