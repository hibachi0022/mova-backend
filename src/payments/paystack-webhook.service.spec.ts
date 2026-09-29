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

        currency =
          'NGN',

        channel =
          'card',

        paidAt =
          '2026-09-29T20:00:00.000Z',
      }: {
        id?:
          | number
          | string;

        amount?: number;
        currency?: string;
        channel?: string;
        paidAt?: string;
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

                currency,

                paid_at:
                  paidAt,

                channel,
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

    it('verifies and settles a successful Paystack charge', async () => {
      const reference =
        'MOVA-abc123';

      const rawBody =
        webhookBody(
          'charge.success',
          reference,
        );

      /*
       * Deliberately larger than JavaScript's safe integer range.
       */
      const verifyResponse =
        `{
          "status": true,
          "message": "Verification successful",
          "data": {
            "id": 1844674407370955161,
            "domain": "test",
            "status": "success",
            "reference": "${reference}",
            "amount": 750000,
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
        fetchMock,
      ).toHaveBeenCalledWith(
        `https://api.paystack.co/transaction/verify/${reference}`,
        expect.objectContaining({
          method:
            'GET',

          headers: {
            Authorization:
              `Bearer ${secretKey}`,

            Accept:
              'application/json',
          },
        }),
      );

      expect(
        rpc,
      ).toHaveBeenCalledWith(
        'complete_outing_payment_from_provider',
        expect.objectContaining({
          p_provider:
            'paystack',

          p_event_type:
            'charge.success',

          p_provider_reference:
            reference,

          p_provider_transaction_id:
            '1844674407370955161',

          p_amount_minor:
            750000,

          p_currency:
            'NGN',

          p_channel:
            'card',

          p_paid_at:
            '2026-09-27T20:00:00.000Z',

          p_payload_hash:
            expect.stringMatching(
              /^[0-9a-f]{64}$/,
            ),
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
          'reconciliation_resolved',
      });
    });

    it('acknowledges a payment that requires reconciliation', async () => {
      const reference =
        'MOVA-late-success';

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

          intentId:
            'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
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
    });
  },
);