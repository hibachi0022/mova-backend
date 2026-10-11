import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { SupabaseService } from '../supabase/supabase.service';
import { TransferPayoutService } from '../transfers/transfer-payout.service';
import { FriendTransferWebhookService } from './friend-transfer-webhook.service';

describe(
  'FriendTransferWebhookService',
  () => {
    let service:
      FriendTransferWebhookService;

    const reference =
      'mova-ft-aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa';

    const payoutId =
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

    const payloadHash =
      'a'.repeat(
        64,
      );

    const rpc =
      jest.fn();

    const payoutInitiate =
      jest.fn();

    const fetchMock =
      jest.fn();

    const originalFetch =
      globalThis.fetch;

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

    function verification(
      overrides: {
        id?:
          number | string;

        status?:
          string;

        reference?:
          string;

        amount?:
          number;

        requestedAmount?:
          number;

        currency?:
          string;

        channel?:
          string;

        paidAt?:
          string | null;
      } = {},
    ) {
      return response(
        200,
        {
          status:
            true,

          data: {
            id:
              overrides.id ??
              123456,

            status:
              overrides.status ??
              'success',

            reference:
              overrides.reference ??
              reference,

            amount:
              overrides.amount ??
              255000,

            requested_amount:
              overrides.requestedAmount ??
              250000,

            currency:
              overrides.currency ??
              'NGN',

            channel:
              overrides.channel ??
              'card',

            paid_at:
              overrides.paidAt ??
              '2026-10-11T18:30:00.000Z',
          },
        },
      );
    }

    beforeEach(
      async () => {
        jest.resetAllMocks();

        globalThis.fetch =
          fetchMock as
            unknown as
            typeof fetch;

        payoutInitiate.mockResolvedValue({
          status:
            'processing',
        });

        const module =
          await Test.createTestingModule({
            providers: [
              FriendTransferWebhookService,

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
                        ? 'sk_test_friend_transfer_webhook'
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

              {
                provide:
                  TransferPayoutService,

                useValue: {
                  initiate:
                    payoutInitiate,
                },
              },
            ],
          }).compile();

        service =
          module.get(
            FriendTransferWebhookService,
          );
      },
    );

    afterAll(
      () => {
        globalThis.fetch =
          originalFetch;
      },
    );

    it('independently verifies, settles, and starts the recipient payout', async () => {
      fetchMock.mockResolvedValueOnce(
        verification(),
      );

      rpc.mockResolvedValue({
        data: {
          status:
            'completed',

          intentId:
            'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',

          quoteId:
            'cccccccc-cccc-4ccc-8ccc-cccccccccccc',

          payoutId,
        },

        error:
          null,
      });

      await expect(
        service.handleChargeSuccess(
          reference,
          payloadHash,
        ),
      ).resolves.toEqual({
        received:
          true,

        status:
          'transfer_payment_completed',
      });

      expect(
        rpc,
      ).toHaveBeenCalledWith(
        'complete_friend_transfer_payment_from_provider',
        {
          p_provider:
            'paystack',

          p_event_type:
            'charge.success',

          p_provider_reference:
            reference,

          p_provider_transaction_id:
            '123456',

          p_amount_minor:
            255000,

          p_requested_amount_minor:
            250000,

          p_currency:
            'NGN',

          p_channel:
            'card',

          p_paid_at:
            '2026-10-11T18:30:00.000Z',

          p_payload_hash:
            payloadHash,
        },
      );

      expect(
        payoutInitiate,
      ).toHaveBeenCalledTimes(
        1,
      );

      expect(
        payoutInitiate,
      ).toHaveBeenCalledWith(
        payoutId,
      );
    });

    it('passes actual and requested Paystack amounts separately', async () => {
      fetchMock.mockResolvedValueOnce(
        verification({
          amount:
            101523,

          requestedAmount:
            100000,
        }),
      );

      rpc.mockResolvedValue({
        data: {
          status:
            'completed',

          payoutId,
        },

        error:
          null,
      });

      await service.handleChargeSuccess(
        reference,
        payloadHash,
      );

      expect(
        rpc,
      ).toHaveBeenCalledWith(
        'complete_friend_transfer_payment_from_provider',
        expect.objectContaining({
          p_amount_minor:
            101523,

          p_requested_amount_minor:
            100000,
        }),
      );
    });

    it('resumes the same payout on an idempotent completed-payment retry', async () => {
      fetchMock.mockResolvedValueOnce(
        verification(),
      );

      rpc.mockResolvedValue({
        data: {
          status:
            'already_completed',

          payoutId,
        },

        error:
          null,
      });

      await expect(
        service.handleChargeSuccess(
          reference,
          payloadHash,
        ),
      ).resolves.toEqual({
        received:
          true,

        status:
          'transfer_payment_already_completed',
      });

      expect(
        payoutInitiate,
      ).toHaveBeenCalledWith(
        payoutId,
      );
    });

    it('surfaces reconciliation instead of starting a payout', async () => {
      fetchMock.mockResolvedValueOnce(
        verification(),
      );

      rpc.mockResolvedValue({
        data: {
          status:
            'reconciliation_required',

          reason:
            'amount_or_currency_mismatch',
        },

        error:
          null,
      });

      await expect(
        service.handleChargeSuccess(
          reference,
          payloadHash,
        ),
      ).resolves.toEqual({
        received:
          true,

        status:
          'transfer_payment_reconciliation_required',
      });

      expect(
        payoutInitiate,
      ).not.toHaveBeenCalled();
    });

    it('ignores a valid provider payment that does not match a MOVA friend-transfer intent', async () => {
      fetchMock.mockResolvedValueOnce(
        verification(),
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
        service.handleChargeSuccess(
          reference,
          payloadHash,
        ),
      ).resolves.toEqual({
        received:
          true,

        status:
          'ignored',
      });

      expect(
        payoutInitiate,
      ).not.toHaveBeenCalled();
    });

    it('rejects a Paystack verification response with a mismatched reference', async () => {
      fetchMock.mockResolvedValueOnce(
        verification({
          reference:
            'mova-ft-bbbbbbbbbbbb4bbb8bbbbbbbbbbbbbbb',
        }),
      );

      await expect(
        service.handleChargeSuccess(
          reference,
          payloadHash,
        ),
      ).rejects.toMatchObject({
        status:
          503,

        message:
          'The verified transfer payment reference did not match the webhook.',
      });

      expect(
        rpc,
      ).not.toHaveBeenCalled();

      expect(
        payoutInitiate,
      ).not.toHaveBeenCalled();
    });

    it('rejects a non-card transaction for the saved-card transfer flow', async () => {
      fetchMock.mockResolvedValueOnce(
        verification({
          channel:
            'bank',
        }),
      );

      await expect(
        service.handleChargeSuccess(
          reference,
          payloadHash,
        ),
      ).rejects.toMatchObject({
        status:
          503,

        message:
          'The verified transfer payment did not use the expected payment channel.',
      });

      expect(
        rpc,
      ).not.toHaveBeenCalled();

      expect(
        payoutInitiate,
      ).not.toHaveBeenCalled();
    });

    it('fails safely if settlement completes without a valid payout id', async () => {
      fetchMock.mockResolvedValueOnce(
        verification(),
      );

      rpc.mockResolvedValue({
        data: {
          status:
            'completed',

          payoutId:
            null,
        },

        error:
          null,
      });

      await expect(
        service.handleChargeSuccess(
          reference,
          payloadHash,
        ),
      ).rejects.toMatchObject({
        status:
          503,

        message:
          'The verified transfer payout could not be loaded safely.',
      });

      expect(
        payoutInitiate,
      ).not.toHaveBeenCalled();
    });

    it('requests a webhook retry when payout initiation remains uncertain', async () => {
      fetchMock.mockResolvedValueOnce(
        verification(),
      );

      rpc.mockResolvedValue({
        data: {
          status:
            'completed',

          payoutId,
        },

        error:
          null,
      });

      payoutInitiate.mockResolvedValueOnce({
        status:
          'verification_pending',
      });

      await expect(
        service.handleChargeSuccess(
          reference,
          payloadHash,
        ),
      ).rejects.toMatchObject({
        status:
          503,

        message:
          'The transfer payment was verified, but recipient payout confirmation is still pending.',
      });

      expect(
        payoutInitiate,
      ).toHaveBeenCalledWith(
        payoutId,
      );
    });
  },
);