import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { SupabaseService } from '../supabase/supabase.service';
import { FriendTransferPayoutWebhookService } from './friend-transfer-payout-webhook.service';

describe(
  'FriendTransferPayoutWebhookService',
  () => {
    let service:
      FriendTransferPayoutWebhookService;

    const reference =
      'mova-po-aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa';

    const payloadHash =
      'a'.repeat(
        64,
      );

    const rpc =
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
      providerStatus:
        string,

      overrides: {
        reference?:
          string;

        amount?:
          number;

        currency?:
          string;

        transferCode?:
          string;

        id?:
          number | string;
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

            amount:
              overrides.amount ??
              250000,

            currency:
              overrides.currency ??
              'NGN',

            reference:
              overrides.reference ??
              reference,

            status:
              providerStatus,

            transfer_code:
              overrides.transferCode ??
              'TRF_testtransfer',
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

        const module =
          await Test.createTestingModule({
            providers: [
              FriendTransferPayoutWebhookService,

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
                        ? 'sk_test_transfer_payout_webhook'
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
            FriendTransferPayoutWebhookService,
          );
      },
    );

    afterAll(
      () => {
        globalThis.fetch =
          originalFetch;
      },
    );

    it('recognizes only supported Paystack transfer events', () => {
      expect(
        service.isTransferEvent(
          'transfer.success',
        ),
      ).toBe(
        true,
      );

      expect(
        service.isTransferEvent(
          'transfer.failed',
        ),
      ).toBe(
        true,
      );

      expect(
        service.isTransferEvent(
          'transfer.reversed',
        ),
      ).toBe(
        true,
      );

      expect(
        service.isTransferEvent(
          'charge.success',
        ),
      ).toBe(
        false,
      );
    });

    it('independently verifies and finalizes a successful payout', async () => {
      fetchMock.mockResolvedValueOnce(
        verification(
          'success',
        ),
      );

      rpc.mockResolvedValue({
        data: {
          status:
            'finalized',

          payoutStatus:
            'success',

          payoutId:
            'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        },

        error:
          null,
      });

      await expect(
        service.handleTransferEvent(
          'transfer.success',
          {
            reference,
          },
          payloadHash,
        ),
      ).resolves.toEqual({
        received:
          true,

        status:
          'transfer_payout_completed',
      });

      expect(
        fetchMock,
      ).toHaveBeenCalledWith(
        `https://api.paystack.co/transfer/verify/${reference}`,
        expect.objectContaining({
          method:
            'GET',
        }),
      );

      expect(
        rpc,
      ).toHaveBeenCalledWith(
        'complete_friend_transfer_payout_from_provider',
        {
          p_provider:
            'paystack',

          p_event_type:
            'transfer.success',

          p_provider_reference:
            reference,

          p_provider_transfer_code:
            'TRF_testtransfer',

          p_provider_transfer_id:
            '123456',

          p_amount_minor:
            250000,

          p_currency:
            'NGN',

          p_provider_status:
            'success',

          p_payload_hash:
            payloadHash,
        },
      );
    });

    it('independently verifies and finalizes a failed payout', async () => {
      fetchMock.mockResolvedValueOnce(
        verification(
          'failed',
        ),
      );

      rpc.mockResolvedValue({
        data: {
          status:
            'finalized',

          payoutStatus:
            'failed',
        },

        error:
          null,
      });

      await expect(
        service.handleTransferEvent(
          'transfer.failed',
          {
            reference,
          },
          payloadHash,
        ),
      ).resolves.toEqual({
        received:
          true,

        status:
          'transfer_payout_failed',
      });
    });

    it('independently verifies a transfer reversal after payout settlement', async () => {
      fetchMock.mockResolvedValueOnce(
        verification(
          'reversed',
        ),
      );

      rpc.mockResolvedValue({
        data: {
          status:
            'finalized',

          payoutStatus:
            'reversed',

          previousPayoutStatus:
            'success',
        },

        error:
          null,
      });

      await expect(
        service.handleTransferEvent(
          'transfer.reversed',
          {
            reference,
          },
          payloadHash,
        ),
      ).resolves.toEqual({
        received:
          true,

        status:
          'transfer_payout_reversed',
      });
    });

    it('ignores transfer webhooks that do not belong to MOVA friend transfers', async () => {
      await expect(
        service.handleTransferEvent(
          'transfer.success',
          {
            reference:
              'other-transfer-reference',
          },
          payloadHash,
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

    it('rejects a provider verification response with a mismatched reference', async () => {
      fetchMock.mockResolvedValueOnce(
        verification(
          'success',
          {
            reference:
              'mova-po-bbbbbbbbbbbb4bbb8bbbbbbbbbbbbbbb',
          },
        ),
      );

      await expect(
        service.handleTransferEvent(
          'transfer.success',
          {
            reference,
          },
          payloadHash,
        ),
      ).rejects.toMatchObject({
        status:
          503,

        message:
          'The verified payout reference did not match the webhook.',
      });

      expect(
        rpc,
      ).not.toHaveBeenCalled();
    });

    it('rejects a webhook event when independent provider status disagrees', async () => {
      fetchMock.mockResolvedValueOnce(
        verification(
          'failed',
        ),
      );

      await expect(
        service.handleTransferEvent(
          'transfer.success',
          {
            reference,
          },
          payloadHash,
        ),
      ).rejects.toMatchObject({
        status:
          503,

        message:
          'The verified payout status did not match the Paystack webhook event.',
      });

      expect(
        rpc,
      ).not.toHaveBeenCalled();
    });

    it('returns reconciliation when verified financial terms require review', async () => {
      fetchMock.mockResolvedValueOnce(
        verification(
          'success',
        ),
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
        service.handleTransferEvent(
          'transfer.success',
          {
            reference,
          },
          payloadHash,
        ),
      ).resolves.toEqual({
        received:
          true,

        status:
          'transfer_payout_reconciliation_required',
      });
    });

    it('returns an idempotent terminal result for a duplicate provider webhook', async () => {
      fetchMock.mockResolvedValueOnce(
        verification(
          'success',
        ),
      );

      rpc.mockResolvedValue({
        data: {
          status:
            'already_finalized',

          payoutStatus:
            'success',
        },

        error:
          null,
      });

      await expect(
        service.handleTransferEvent(
          'transfer.success',
          {
            reference,
          },
          payloadHash,
        ),
      ).resolves.toEqual({
        received:
          true,

        status:
          'transfer_payout_already_finalized',
      });
    });
  },
);