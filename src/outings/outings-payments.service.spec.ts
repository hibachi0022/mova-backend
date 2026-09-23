import { Test } from '@nestjs/testing';
import { SupabaseService } from '../supabase/supabase.service';
import {
  OutingsPaymentProviderService,
} from './outings-payment-provider.service';
import {
  OutingsPaymentsService,
} from './outings-payments.service';
import {
  OutingResponse,
  OutingsService,
} from './outings.service';

describe(
  'OutingsPaymentsService',
  () => {
    let service:
      OutingsPaymentsService;

    const rpc =
      jest.fn();

    const maybeSingle =
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

    beforeEach(
      async () => {
        jest.resetAllMocks();

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
                          () => ({
                            select:
                              () => ({
                                eq:
                                  () => ({
                                    maybeSingle,
                                  }),
                              }),
                          }),
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
      ).toHaveBeenCalledWith(
        {
          currency:
            'NGN',
          amountMinor:
            500000,
          hasSelectedPayer:
            true,
        },
      );

      expect(result).toEqual({
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

    it('creates and attaches provider checkout', async () => {
      rpc.mockImplementation(
        (
          name: string,
        ) => {
          if (
            name ===
            'prepare_outing_payment_intent'
          ) {
            return Promise.resolve(
              {
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
              },
            );
          }

          if (
            name ===
            'attach_outing_payment_checkout'
          ) {
            return Promise.resolve(
              {
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
              },
            );
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
      ).toHaveBeenCalledWith(
        {
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
        },
      );

      expect(
        rpc,
      ).toHaveBeenCalledWith(
        'attach_outing_payment_checkout',
        {
          p_user_id:
            userId,
          p_intent_id:
            intentId,
          p_provider:
            'paystack',
          p_provider_checkout_id:
            'access_123',
          p_provider_reference:
            'MOVA-reference',
          p_checkout_url:
            'https://checkout.paystack.com/test',
          p_expires_at:
            '2099-10-01T18:15:00.000Z',
        },
      );
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

      maybeSingle.mockResolvedValue(
        {
          data: {
            id:
              intentId,
            status:
              'checkout_ready',
            checkout_url:
              'https://checkout.paystack.com/existing',
            expires_at:
              '2099-10-01T18:15:00.000Z',
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
      providerAvailability.mockReturnValue(
        {
          available:
            false,
          reason:
            'PayPal is not connected to the current payment provider yet.',
        },
      );

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