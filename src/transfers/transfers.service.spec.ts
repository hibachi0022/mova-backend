import { Test } from '@nestjs/testing';
import { SupabaseService } from '../supabase/supabase.service';
import { TransfersService } from './transfers.service';

describe(
  'TransfersService',
  () => {
    let service:
      TransfersService;

    const senderId =
      '11111111-1111-4111-8111-111111111111';

    const recipientId =
      '22222222-2222-4222-8222-222222222222';

    const paymentMethodId =
      '33333333-3333-4333-8333-333333333333';

    const quoteId =
      '44444444-4444-4444-8444-444444444444';

    const rpc =
      jest.fn();

    const input = {
      recipientId,

      paymentMethodId,

      amountMinor:
        250000,

      currency:
        'NGN' as const,
    };

    beforeEach(
      async () => {
        jest.resetAllMocks();

        const module =
          await Test.createTestingModule({
            providers: [
              TransfersService,

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
            TransfersService,
          );
      },
    );

    it('creates a trusted friend transfer quote', async () => {
      rpc.mockResolvedValue({
        data: {
          status:
            'created',

          quoteId,

          recipientId,

          paymentMethodId,

          amountMinor:
            250000,

          feeMinor:
            0,

          totalMinor:
            250000,

          currency:
            'NGN',

          expiresAt:
            new Date(
              Date.now() +
                5 * 60_000,
            ).toISOString(),
        },

        error:
          null,
      });

      await expect(
        service.createQuote(
          senderId,
          input,
        ),
      ).resolves.toMatchObject({
        id:
          quoteId,

        recipientId,

        paymentMethodId,

        amountMinor:
          250000,

        feeMinor:
          0,

        totalMinor:
          250000,

        currency:
          'NGN',
      });

      expect(
        rpc,
      ).toHaveBeenCalledWith(
        'prepare_friend_transfer_quote',
        {
          p_sender_user_id:
            senderId,

          p_recipient_user_id:
            recipientId,

          p_payment_method_id:
            paymentMethodId,

          p_amount_minor:
            250000,

          p_currency:
            'NGN',
        },
      );
    });

    it('rejects a recipient who is no longer an accepted friend', async () => {
      rpc.mockResolvedValue({
        data: {
          status:
            'not_friends',
        },

        error:
          null,
      });

      await expect(
        service.createQuote(
          senderId,
          input,
        ),
      ).rejects.toMatchObject({
        status:
          409,

        message:
          'You can only send money to an accepted friend.',
      });
    });

    it('rejects transfers when either account has blocked the other', async () => {
      rpc.mockResolvedValue({
        data: {
          status:
            'blocked',
        },

        error:
          null,
      });

      await expect(
        service.createQuote(
          senderId,
          input,
        ),
      ).rejects.toMatchObject({
        status:
          403,
      });
    });

    it('rejects a recipient without an active receiving account', async () => {
      rpc.mockResolvedValue({
        data: {
          status:
            'recipient_no_receiving_account',
        },

        error:
          null,
      });

      await expect(
        service.createQuote(
          senderId,
          input,
        ),
      ).rejects.toMatchObject({
        status:
          409,

        message:
          'This friend has not set up a receiving account yet.',
      });
    });

    it('rejects an unavailable sender payment method', async () => {
      rpc.mockResolvedValue({
        data: {
          status:
            'payment_method_unavailable',
        },

        error:
          null,
      });

      await expect(
        service.createQuote(
          senderId,
          input,
        ),
      ).rejects.toMatchObject({
        status:
          409,
      });
    });

    it('rejects an invalid quote request returned by the database', async () => {
      rpc.mockResolvedValue({
        data: {
          status:
            'invalid',
        },

        error:
          null,
      });

      await expect(
        service.createQuote(
          senderId,
          input,
        ),
      ).rejects.toMatchObject({
        status:
          400,
      });
    });

    it('fails safely when the quote database operation fails', async () => {
      rpc.mockResolvedValue({
        data:
          null,

        error: {
          message:
            'database unavailable',
        },
      });

      await expect(
        service.createQuote(
          senderId,
          input,
        ),
      ).rejects.toMatchObject({
        status:
          503,

        message:
          'Unable to prepare the transfer quote right now.',
      });
    });

    it('rejects malformed trusted quote data', async () => {
      rpc.mockResolvedValue({
        data: {
          status:
            'created',

          quoteId,

          recipientId,

          paymentMethodId,

          amountMinor:
            250000,

          feeMinor:
            5000,

          totalMinor:
            250000,

          currency:
            'NGN',

          expiresAt:
            new Date(
              Date.now() +
                5 * 60_000,
            ).toISOString(),
        },

        error:
          null,
      });

      await expect(
        service.createQuote(
          senderId,
          input,
        ),
      ).rejects.toMatchObject({
        status:
          503,

        message:
          'The transfer quote amount could not be loaded safely.',
      });
    });
  },
);