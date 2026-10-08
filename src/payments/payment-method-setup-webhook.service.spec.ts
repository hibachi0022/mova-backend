import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { SupabaseService } from '../supabase/supabase.service';
import { PaymentMethodSetupWebhookService } from './payment-method-setup-webhook.service';

describe(
  'PaymentMethodSetupWebhookService',
  () => {
    let service:
      PaymentMethodSetupWebhookService;

    const secretKey =
      'sk_test_setup_webhook';

    const reference =
      'MOVA-CARD-aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa';

    const transactionId =
      '123456789';

    const rpc =
      jest.fn();

    const fetchMock =
      jest.fn();

    const originalFetch =
      globalThis.fetch;

    function verification(
      {
        reusable =
          true,

        verifiedReference =
          reference,
      }: {
        reusable?:
          boolean;

        verifiedReference?:
          string;
      } = {},
    ) {
      return {
        ok:
          true,

        status:
          200,

        text:
          async () =>
            JSON.stringify({
              status:
                true,

              data: {
                id:
                  Number(
                    transactionId,
                  ),

                status:
                  'success',

                reference:
                  verifiedReference,

                amount:
                  5000,

                requested_amount:
                  5000,

                currency:
                  'NGN',

                channel:
                  'card',

                paid_at:
                  '2026-10-08T00:30:00.000Z',

                authorization: {
                  authorization_code:
                    'AUTH_setup',

                  last4:
                    '4081',

                  exp_month:
                    '09',

                  exp_year:
                    '2030',

                  channel:
                    'card',

                  brand:
                    'visa',

                  reusable,

                  signature:
                    'SIG_setup',

                  bank:
                    'TEST BANK',

                  country_code:
                    'NG',
                },

                customer: {
                  email:
                    'samuel@example.com',

                  customer_code:
                    'CUS_setup',
                },
              },
            }),
      } as Response;
    }

    function refundCreated() {
      return {
        ok:
          true,

        status:
          200,

        text:
          async () =>
            JSON.stringify({
              status:
                true,

              data: {
                id:
                  777,

                status:
                  'pending',

                refunded_at:
                  null,
              },
            }),
      } as Response;
    }

    beforeEach(
      async () => {
        jest.resetAllMocks();

        globalThis.fetch =
          fetchMock as unknown as
            typeof fetch;

        const module =
          await Test.createTestingModule({
            providers: [
              PaymentMethodSetupWebhookService,

              {
                provide:
                  ConfigService,

                useValue: {
                  get:
                    (
                      key:
                        string,
                    ) =>
                      key ===
                      'PAYSTACK_SECRET_KEY'
                        ? secretKey
                        : undefined,
                },
              },

              {
                provide:
                  SupabaseService,

                useValue: {
                  createAdminClient:
                    () => ({
                      rpc,
                    }),
                },
              },
            ],
          }).compile();

        service =
          module.get(
            PaymentMethodSetupWebhookService,
          );
      },
    );

    afterAll(
      () => {
        globalThis.fetch =
          originalFetch;
      },
    );

    it('verifies the standalone charge, saves the reusable card, and requests a full refund', async () => {
      fetchMock
        .mockResolvedValueOnce(
          verification(),
        )
        .mockResolvedValueOnce(
          refundCreated(),
        );

      rpc.mockImplementation(
        async (
          name:
            string,
        ) => {
          if (
            name ===
            'complete_payment_method_setup_from_provider'
          ) {
            return {
              data: {
                status:
                  'completed',

                setupStatus:
                  'completed',

                paymentMethodId:
                  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',

                providerTransactionId:
                  transactionId,

                refundStatus:
                  'not_requested',
              },

              error:
                null,
            };
          }

          if (
            name ===
            'begin_payment_method_setup_refund'
          ) {
            return {
              data: {
                status:
                  'ready',

                providerTransactionId:
                  transactionId,

                refundStatus:
                  'initiating',
              },

              error:
                null,
            };
          }

          if (
            name ===
            'record_payment_method_setup_refund'
          ) {
            return {
              data: {
                status:
                  'updated',

                refundStatus:
                  'pending',

                providerRefundId:
                  '777',
              },

              error:
                null,
            };
          }

          throw new Error(
            `Unexpected RPC ${name}`,
          );
        },
      );

      await expect(
        service.handleChargeSuccess(
          reference,
        ),
      ).resolves.toEqual({
        received:
          true,

        status:
          'card_setup_completed',
      });

      expect(
        rpc,
      ).toHaveBeenCalledWith(
        'complete_payment_method_setup_from_provider',
        expect.objectContaining({
          p_provider_reference:
            reference,

          p_provider_transaction_id:
            transactionId,

          p_amount_minor:
            5000,

          p_requested_amount_minor:
            5000,

          p_currency:
            'NGN',

          p_channel:
            'card',

          p_provider_email:
            'samuel@example.com',

          p_provider_authorization_code:
            'AUTH_setup',

          p_provider_signature:
            'SIG_setup',

          p_last4:
            '4081',

          p_reusable:
            true,
        }),
      );

      const refundCall =
        fetchMock.mock.calls[1];

      expect(
        refundCall[0],
      ).toBe(
        'https://api.paystack.co/refund',
      );

      const refundBody =
        JSON.parse(
          (
            refundCall[1] as
              RequestInit
          ).body as
            string,
        ) as
          Record<
            string,
            unknown
          >;

      expect(
        refundBody.transaction,
      ).toBe(
        transactionId,
      );

      expect(
        refundBody,
      ).not.toHaveProperty(
        'amount',
      );
    });

    it('refunds the verification charge even when the card authorization is not reusable', async () => {
      fetchMock
        .mockResolvedValueOnce(
          verification({
            reusable:
              false,
          }),
        )
        .mockResolvedValueOnce(
          refundCreated(),
        );

      rpc.mockImplementation(
        async (
          name:
            string,
        ) => {
          if (
            name ===
            'complete_payment_method_setup_from_provider'
          ) {
            return {
              data: {
                status:
                  'card_unavailable',

                providerTransactionId:
                  transactionId,

                refundStatus:
                  'not_requested',
              },

              error:
                null,
            };
          }

          if (
            name ===
            'begin_payment_method_setup_refund'
          ) {
            return {
              data: {
                status:
                  'ready',

                providerTransactionId:
                  transactionId,
              },

              error:
                null,
            };
          }

          if (
            name ===
            'record_payment_method_setup_refund'
          ) {
            return {
              data: {
                status:
                  'updated',

                refundStatus:
                  'pending',
              },

              error:
                null,
            };
          }

          throw new Error(
            `Unexpected RPC ${name}`,
          );
        },
      );

      await expect(
        service.handleChargeSuccess(
          reference,
        ),
      ).resolves.toEqual({
        received:
          true,

        status:
          'card_setup_failed',
      });

      expect(
        fetchMock,
      ).toHaveBeenCalledTimes(
        2,
      );
    });

    it('does not create a second refund when one is already pending', async () => {
      fetchMock.mockResolvedValueOnce(
        verification(),
      );

      rpc.mockImplementation(
        async (
          name:
            string,
        ) => {
          if (
            name ===
            'complete_payment_method_setup_from_provider'
          ) {
            return {
              data: {
                status:
                  'existing',

                setupStatus:
                  'completed',

                providerTransactionId:
                  transactionId,

                refundStatus:
                  'pending',
              },

              error:
                null,
            };
          }

          if (
            name ===
            'begin_payment_method_setup_refund'
          ) {
            return {
              data: {
                status:
                  'existing',

                providerTransactionId:
                  transactionId,

                refundStatus:
                  'pending',

                providerRefundId:
                  '777',
              },

              error:
                null,
            };
          }

          throw new Error(
            `Unexpected RPC ${name}`,
          );
        },
      );

      await expect(
        service.handleChargeSuccess(
          reference,
        ),
      ).resolves.toEqual({
        received:
          true,

        status:
          'card_setup_completed',
      });

      expect(
        fetchMock,
      ).toHaveBeenCalledTimes(
        1,
      );
    });

    it('reconciles an uncertain refund instead of creating another refund', async () => {
      fetchMock
        .mockResolvedValueOnce(
          verification(),
        )
        .mockResolvedValueOnce({
          ok:
            true,

          status:
            200,

          text:
            async () =>
              JSON.stringify({
                status:
                  true,

                data: [
                  {
                    id:
                      777,

                    status:
                      'processing',

                    refunded_at:
                      null,
                  },
                ],
              }),
        } as Response);

      rpc.mockImplementation(
        async (
          name:
            string,
        ) => {
          if (
            name ===
            'complete_payment_method_setup_from_provider'
          ) {
            return {
              data: {
                status:
                  'existing',

                setupStatus:
                  'completed',

                providerTransactionId:
                  transactionId,

                refundStatus:
                  'initiating',
              },

              error:
                null,
            };
          }

          if (
            name ===
            'begin_payment_method_setup_refund'
          ) {
            return {
              data: {
                status:
                  'existing',

                providerTransactionId:
                  transactionId,

                refundStatus:
                  'initiating',
              },

              error:
                null,
            };
          }

          if (
            name ===
            'record_payment_method_setup_refund'
          ) {
            return {
              data: {
                status:
                  'updated',

                refundStatus:
                  'processing',

                providerRefundId:
                  '777',
              },

              error:
                null,
            };
          }

          throw new Error(
            `Unexpected RPC ${name}`,
          );
        },
      );

      await service.handleChargeSuccess(
        reference,
      );

      expect(
        fetchMock,
      ).toHaveBeenCalledTimes(
        2,
      );

      expect(
        String(
          fetchMock.mock
            .calls[1][0],
        ),
      ).toContain(
        `/refund?transaction=${transactionId}`,
      );

      expect(
        fetchMock.mock.calls.some(
          (
            call,
          ) =>
            call[0] ===
              'https://api.paystack.co/refund' &&
            (
              call[1] as
                RequestInit
            )?.method ===
              'POST',
        ),
      ).toBe(
        false,
      );
    });

    it('records a processed refund webhook', async () => {
      rpc.mockResolvedValue({
        data: {
          status:
            'updated',

          refundStatus:
            'processed',

          providerRefundId:
            '777',
        },

        error:
          null,
      });

      await expect(
        service.handleRefundEvent(
          'refund.processed',
          {
            transaction_reference:
              reference,

            status:
              'processed',

            refunded_at:
              '2026-10-08T00:40:00.000Z',
          },
        ),
      ).resolves.toEqual({
        received:
          true,

        status:
          'card_setup_refunded',
      });

      expect(
        rpc,
      ).toHaveBeenCalledWith(
        'record_payment_method_setup_refund',
        {
          p_provider_reference:
            reference,

          p_provider_refund_id:
            null,

          p_refund_status:
            'processed',

          p_refunded_at:
            '2026-10-08T00:40:00.000Z',
        },
      );
    });

    it('maps Paystack needs-attention to MOVA needs_attention', async () => {
      rpc.mockResolvedValue({
        data: {
          status:
            'updated',

          refundStatus:
            'needs_attention',
        },

        error:
          null,
      });

      await expect(
        service.handleRefundEvent(
          'refund.needs-attention',
          {
            transaction_reference:
              reference,
          },
        ),
      ).resolves.toEqual({
        received:
          true,

        status:
          'card_setup_failed',
      });

      expect(
        rpc,
      ).toHaveBeenCalledWith(
        'record_payment_method_setup_refund',
        expect.objectContaining({
          p_refund_status:
            'needs_attention',
        }),
      );
    });

    it('ignores refund webhooks unrelated to MOVA standalone card setup', async () => {
      await expect(
        service.handleRefundEvent(
          'refund.pending',
          {
            transaction_reference:
              'OTHER-TRANSACTION',
          },
        ),
      ).resolves.toEqual({
        received:
          true,

        status:
          'ignored',
      });

      expect(
        rpc,
      ).not.toHaveBeenCalled();
    });

    it('rejects a Paystack verification response with a mismatched reference', async () => {
      fetchMock.mockResolvedValueOnce(
        verification({
          verifiedReference:
            'MOVA-CARD-wrong',
        }),
      );

      await expect(
        service.handleChargeSuccess(
          reference,
        ),
      ).rejects.toMatchObject({
        status:
          503,

        message:
          'The verified card setup reference did not match the webhook.',
      });

      expect(
        rpc,
      ).not.toHaveBeenCalled();
    });
  },
);