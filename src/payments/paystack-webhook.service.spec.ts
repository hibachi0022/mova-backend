import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { SupabaseService } from '../supabase/supabase.service';
import { PaystackWebhookService } from './paystack-webhook.service';

describe(
  'PaystackWebhookService',
  () => {
    let service:
      PaystackWebhookService;

    const secretKey =
      'sk_test_mova_webhook_unit_test_secret';

    const rpc =
      jest.fn();

    const fetchMock =
      jest.fn();

    const originalFetch =
      globalThis.fetch;

    function sign(
      rawBody: Buffer,
    ) {
      return createHmac(
        'sha512',
        secretKey,
      )
        .update(
          rawBody,
        )
        .digest(
          'hex',
        );
    }

    function webhookBody(
      event:
        string =
          'charge.success',

      reference:
        string =
          'MOVA-test-reference',
    ) {
      return Buffer.from(
        JSON.stringify({
          event,

          data: {
            reference,
          },
        }),
        'utf8',
      );
    }

    function successfulVerification(
      reference: string,
      {
        id =
          123456,

        amount =
          500000,

        requestedAmount =
          amount,

        currency =
          'NGN',

        channel =
          'card',

        paidAt =
          '2026-09-29T20:00:00.000Z',

        reusableCard =
          false,

        reusable =
          true,
      }: {
        id?:
          | number
          | string;

        amount?: number;

        requestedAmount?:
          number;

        currency?: string;

        channel?: string;

        paidAt?: string;

        reusableCard?:
          boolean;

        reusable?:
          boolean;
      } = {},
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
                'Verification successful',

              data: {
                id,

                status:
                  'success',

                reference,

                amount,

                requested_amount:
                  requestedAmount,

                currency,

                paid_at:
                  paidAt,

                channel,

                ...(reusableCard
                  ? {
                      authorization: {
                        authorization_code:
                          'AUTH_test_4081',

                        last4:
                          '4081',

                        exp_month:
                          '12',

                        exp_year:
                          '2030',

                        channel:
                          'card',

                        card_type:
                          'visa ',

                        bank:
                          'TEST BANK',

                        country_code:
                          'NG',

                        brand:
                          'visa',

                        reusable,

                        signature:
                          'SIG_test_4081',
                      },

                      customer: {
                        email:
                          'samuel@example.com',

                        customer_code:
                          'CUS_test_samuel',
                      },
                    }
                  : {}),
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

        const module =
          await Test.createTestingModule({
            providers: [
              PaystackWebhookService,

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
            PaystackWebhookService,
          );
      },
    );

    afterAll(
      () => {
        globalThis.fetch =
          originalFetch;
      },
    );

    it('rejects an invalid Paystack signature', async () => {
      const rawBody =
        webhookBody();

      await expect(
        service.handle(
          rawBody,
          '0'.repeat(
            128,
          ),
        ),
      ).rejects.toMatchObject({
        status:
          401,

        message:
          'Invalid Paystack webhook signature.',
      });

      expect(
        fetchMock,
      ).not.toHaveBeenCalled();

      expect(
        rpc,
      ).not.toHaveBeenCalled();
    });

    it('acknowledges signed Paystack events that MOVA does not process', async () => {
      const rawBody =
        webhookBody(
          'transfer.success',
        );

      await expect(
        service.handle(
          rawBody,
          sign(
            rawBody,
          ),
        ),
      ).resolves.toEqual({
        received:
          true,

        status:
          'ignored',
      });

      expect(
        fetchMock,
      ).not.toHaveBeenCalled();

      expect(
        rpc,
      ).not.toHaveBeenCalled();
    });

    it('passes actual and requested Paystack amounts separately', async () => {
      const reference =
        'MOVA-fee-pass-test';

      const rawBody =
        webhookBody(
          'charge.success',
          reference,
        );

      successfulVerification(
        reference,
        {
          amount:
            101523,

          requestedAmount:
            100000,
        },
      );

      rpc.mockResolvedValue({
        data: {
          status:
            'completed',

          intentId:
            'cccccccc-cccc-4ccc-8ccc-cccccccccccc',

          outingId:
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        },

        error:
          null,
      });

      await expect(
        service.handle(
          rawBody,
          sign(
            rawBody,
          ),
        ),
      ).resolves.toEqual({
        received:
          true,

        status:
          'completed',
      });

      expect(
        rpc,
      ).toHaveBeenCalledWith(
        'complete_outing_payment_from_provider',
        expect.objectContaining({
          p_provider:
            'paystack',

          p_provider_reference:
            reference,

          p_amount_minor:
            101523,

          p_requested_amount_minor:
            100000,

          p_currency:
            'NGN',
        }),
      );
    });

    it('saves a verified reusable card authorization after settlement', async () => {
      const reference =
        'MOVA-save-card-test';

      const rawBody =
        webhookBody(
          'charge.success',
          reference,
        );

      successfulVerification(
        reference,
        {
          amount:
            101523,

          requestedAmount:
            100000,

          reusableCard:
            true,
        },
      );

      rpc.mockImplementation(
        (
          name:
            string,
        ) => {
          if (
            name ===
            'complete_outing_payment_from_provider'
          ) {
            return Promise.resolve({
              data: {
                status:
                  'completed',

                intentId:
                  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',

                outingId:
                  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              },

              error:
                null,
            });
          }

          if (
            name ===
            'save_outing_payment_method_from_provider'
          ) {
            return Promise.resolve({
              data: {
                status:
                  'saved',

                methodId:
                  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
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
        service.handle(
          rawBody,
          sign(
            rawBody,
          ),
        ),
      ).resolves.toEqual({
        received:
          true,

        status:
          'completed',
      });

      expect(
        rpc,
      ).toHaveBeenCalledWith(
        'save_outing_payment_method_from_provider',
        {
          p_provider:
            'paystack',

          p_provider_reference:
            reference,

          p_provider_customer_code:
            'CUS_test_samuel',

          p_provider_email:
            'samuel@example.com',

          p_provider_authorization_code:
            'AUTH_test_4081',

          p_provider_signature:
            'SIG_test_4081',

          p_network:
            'visa',

          p_last4:
            '4081',

          p_exp_month:
            12,

          p_exp_year:
            2030,

          p_bank:
            'TEST BANK',

          p_country_code:
            'NG',

          p_paid_at:
            '2026-09-29T20:00:00.000Z',
        },
      );

      const settlementCall =
        rpc.mock.calls.findIndex(
          (
            call,
          ) =>
            call[0] ===
            'complete_outing_payment_from_provider',
        );

      const saveCall =
        rpc.mock.calls.findIndex(
          (
            call,
          ) =>
            call[0] ===
            'save_outing_payment_method_from_provider',
        );

      expect(
        settlementCall,
      ).toBeGreaterThanOrEqual(
        0,
      );

      expect(
        saveCall,
      ).toBeGreaterThan(
        settlementCall,
      );
    });

    it('does not save a non-reusable Paystack authorization', async () => {
      const reference =
        'MOVA-not-reusable';

      const rawBody =
        webhookBody(
          'charge.success',
          reference,
        );

      successfulVerification(
        reference,
        {
          reusableCard:
            true,

          reusable:
            false,
        },
      );

      rpc.mockResolvedValue({
        data: {
          status:
            'completed',
        },

        error:
          null,
      });

      await expect(
        service.handle(
          rawBody,
          sign(
            rawBody,
          ),
        ),
      ).resolves.toEqual({
        received:
          true,

        status:
          'completed',
      });

      expect(
        rpc,
      ).toHaveBeenCalledTimes(
        1,
      );

      expect(
        rpc,
      ).not.toHaveBeenCalledWith(
        'save_outing_payment_method_from_provider',
        expect.anything(),
      );
    });

    it('allows the database to reject card saving when consent was not requested', async () => {
      const reference =
        'MOVA-no-save-consent';

      const rawBody =
        webhookBody(
          'charge.success',
          reference,
        );

      successfulVerification(
        reference,
        {
          reusableCard:
            true,
        },
      );

      rpc.mockImplementation(
        (
          name:
            string,
        ) => {
          if (
            name ===
            'complete_outing_payment_from_provider'
          ) {
            return Promise.resolve({
              data: {
                status:
                  'completed',
              },

              error:
                null,
            });
          }

          if (
            name ===
            'save_outing_payment_method_from_provider'
          ) {
            return Promise.resolve({
              data: {
                status:
                  'not_requested',
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
        service.handle(
          rawBody,
          sign(
            rawBody,
          ),
        ),
      ).resolves.toEqual({
        received:
          true,

        status:
          'completed',
      });

      expect(
        rpc,
      ).toHaveBeenCalledTimes(
        2,
      );
    });

    it('returns a temporary failure when saved-card persistence has a transient database error', async () => {
      const reference =
        'MOVA-save-card-db-error';

      const rawBody =
        webhookBody(
          'charge.success',
          reference,
        );

      successfulVerification(
        reference,
        {
          reusableCard:
            true,
        },
      );

      rpc.mockImplementation(
        (
          name:
            string,
        ) => {
          if (
            name ===
            'complete_outing_payment_from_provider'
          ) {
            return Promise.resolve({
              data: {
                status:
                  'completed',
              },

              error:
                null,
            });
          }

          if (
            name ===
            'save_outing_payment_method_from_provider'
          ) {
            return Promise.resolve({
              data:
                null,

              error: {
                message:
                  'database unavailable',
              },
            });
          }

          throw new Error(
            `Unexpected RPC ${name}`,
          );
        },
      );

      await expect(
        service.handle(
          rawBody,
          sign(
            rawBody,
          ),
        ),
      ).rejects.toMatchObject({
        status:
          503,

        message:
          'Payment was verified but the saved payment method could not be recorded right now.',
      });
    });

    it('preserves large Paystack transaction IDs exactly', async () => {
      const reference =
        'MOVA-large-id';

      const rawBody =
        webhookBody(
          'charge.success',
          reference,
        );

      const verifyResponse =
        `{
          "status": true,
          "message": "Verification successful",
          "data": {
            "id": 1844674407370955161,
            "status": "success",
            "reference": "${reference}",
            "amount": 750000,
            "requested_amount": 750000,
            "paid_at": "2026-09-27T20:00:00.000Z",
            "channel": "card",
            "currency": "NGN"
          }
        }`;

      fetchMock.mockResolvedValue({
        ok:
          true,

        status:
          200,

        text:
          async () =>
            verifyResponse,
      } as Response);

      rpc.mockResolvedValue({
        data: {
          status:
            'completed',
        },

        error:
          null,
      });

      await service.handle(
        rawBody,
        sign(
          rawBody,
        ),
      );

      expect(
        rpc,
      ).toHaveBeenCalledWith(
        'complete_outing_payment_from_provider',
        expect.objectContaining({
          p_provider_transaction_id:
            '1844674407370955161',

          p_amount_minor:
            750000,

          p_requested_amount_minor:
            750000,
        }),
      );
    });

    it('handles a repeated successful webhook idempotently', async () => {
      const reference =
        'MOVA-repeat-test';

      const rawBody =
        webhookBody(
          'charge.success',
          reference,
        );

      successfulVerification(
        reference,
      );

      rpc.mockResolvedValue({
        data: {
          status:
            'already_completed',
        },

        error:
          null,
      });

      await expect(
        service.handle(
          rawBody,
          sign(
            rawBody,
          ),
        ),
      ).resolves.toEqual({
        received:
          true,

        status:
          'already_completed',
      });
    });

    it('retries saved-card persistence on an already-completed webhook retry', async () => {
      const reference =
        'MOVA-repeat-save-card';

      const rawBody =
        webhookBody(
          'charge.success',
          reference,
        );

      successfulVerification(
        reference,
        {
          reusableCard:
            true,
        },
      );

      rpc.mockImplementation(
        (
          name:
            string,
        ) => {
          if (
            name ===
            'complete_outing_payment_from_provider'
          ) {
            return Promise.resolve({
              data: {
                status:
                  'already_completed',
              },

              error:
                null,
            });
          }

          if (
            name ===
            'save_outing_payment_method_from_provider'
          ) {
            return Promise.resolve({
              data: {
                status:
                  'updated',
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
        service.handle(
          rawBody,
          sign(
            rawBody,
          ),
        ),
      ).resolves.toEqual({
        received:
          true,

        status:
          'already_completed',
      });

      expect(
        rpc,
      ).toHaveBeenCalledWith(
        'save_outing_payment_method_from_provider',
        expect.anything(),
      );
    });

    it('acknowledges a webhook retry after refund reconciliation was resolved', async () => {
      const reference =
        'MOVA-refunded-reconciliation';

      const rawBody =
        webhookBody(
          'charge.success',
          reference,
        );

      successfulVerification(
        reference,
      );

      rpc.mockResolvedValue({
        data: {
          status:
            'reconciliation_resolved',

          resolution:
            'refunded',
        },

        error:
          null,
      });

      await expect(
        service.handle(
          rawBody,
          sign(
            rawBody,
          ),
        ),
      ).resolves.toEqual({
        received:
          true,

        status:
          'reconciliation_resolved',
      });
    });

    it('acknowledges a payment that requires reconciliation', async () => {
      const reference =
        'MOVA-reconcile-test';

      const rawBody =
        webhookBody(
          'charge.success',
          reference,
        );

      successfulVerification(
        reference,
      );

      rpc.mockResolvedValue({
        data: {
          status:
            'reconciliation_required',

          reason:
            'late_success_expired',
        },

        error:
          null,
      });

      await expect(
        service.handle(
          rawBody,
          sign(
            rawBody,
          ),
        ),
      ).resolves.toEqual({
        received:
          true,

        status:
          'reconciliation_required',
      });
    });

    it('does not save a card while payment reconciliation is required', async () => {
      const reference =
        'MOVA-reconcile-save-card';

      const rawBody =
        webhookBody(
          'charge.success',
          reference,
        );

      successfulVerification(
        reference,
        {
          reusableCard:
            true,
        },
      );

      rpc.mockResolvedValue({
        data: {
          status:
            'reconciliation_required',

          reason:
            'late_success_expired',
        },

        error:
          null,
      });

      await expect(
        service.handle(
          rawBody,
          sign(
            rawBody,
          ),
        ),
      ).resolves.toEqual({
        received:
          true,

        status:
          'reconciliation_required',
      });

      expect(
        rpc,
      ).toHaveBeenCalledTimes(
        1,
      );

      expect(
        rpc,
      ).not.toHaveBeenCalledWith(
        'save_outing_payment_method_from_provider',
        expect.anything(),
      );
    });

    it('rejects verification that omits requested_amount', async () => {
      const reference =
        'MOVA-no-requested-amount';

      const rawBody =
        webhookBody(
          'charge.success',
          reference,
        );

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

              data: {
                id:
                  123456,

                status:
                  'success',

                reference,

                amount:
                  500000,

                currency:
                  'NGN',

                paid_at:
                  '2026-09-29T20:00:00.000Z',

                channel:
                  'card',
              },
            }),
      } as Response);

      await expect(
        service.handle(
          rawBody,
          sign(
            rawBody,
          ),
        ),
      ).rejects.toMatchObject({
        status:
          503,

        message:
          'Paystack returned an invalid requested payment amount.',
      });

      expect(
        rpc,
      ).not.toHaveBeenCalled();
    });

    it('returns a temporary failure when Paystack verification is unavailable', async () => {
      const reference =
        'MOVA-temporary-failure';

      const rawBody =
        webhookBody(
          'charge.success',
          reference,
        );

      fetchMock.mockResolvedValue({
        ok:
          false,

        status:
          503,

        text:
          async () =>
            JSON.stringify({
              status:
                false,

              message:
                'Unavailable',
            }),
      } as Response);

      await expect(
        service.handle(
          rawBody,
          sign(
            rawBody,
          ),
        ),
      ).rejects.toMatchObject({
        status:
          503,
      });

      expect(
        rpc,
      ).not.toHaveBeenCalled();
    });

    it('acknowledges a verified transaction that does not belong to an MOVA outing', async () => {
      const reference =
        'OTHER-product-payment';

      const rawBody =
        webhookBody(
          'charge.success',
          reference,
        );

      successfulVerification(
        reference,
        {
          amount:
            100000,

          requestedAmount:
            100000,

          reusableCard:
            true,
        },
      );

      rpc.mockResolvedValue({
        data: {
          status:
            'not_found',
        },

        error:
          null,
      });

      await expect(
        service.handle(
          rawBody,
          sign(
            rawBody,
          ),
        ),
      ).resolves.toEqual({
        received:
          true,

        status:
          'ignored',
      });

      expect(
        rpc,
      ).toHaveBeenCalledTimes(
        1,
      );
    });
  },
);