import { Test } from '@nestjs/testing';
import { SupabaseService } from '../supabase/supabase.service';
import {
  OutingsPaymentReceiptsService,
} from './outings-payment-receipts.service';
import {
  OutingResponse,
  OutingsService,
} from './outings.service';

describe(
  'OutingsPaymentReceiptsService',
  () => {
    let service:
      OutingsPaymentReceiptsService;

    const maybeSingle =
      jest.fn();

    const eqStatus =
      jest.fn();

    const eqOuting =
      jest.fn();

    const select =
      jest.fn();

    const outingsGet =
      jest.fn();

    const userId =
      '11111111-1111-4111-8111-111111111111';

    const outingId =
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    const memberId =
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    const paymentId =
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
          100000,

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

        maybeSingle.mockResolvedValue({
          data:
            null,

          error:
            null,
        });

        eqStatus.mockReturnValue({
          maybeSingle,
        });

        eqOuting.mockReturnValue({
          eq:
            eqStatus,
        });

        select.mockReturnValue({
          eq:
            eqOuting,
        });

        const module =
          await Test.createTestingModule({
            providers: [
              OutingsPaymentReceiptsService,

              {
                provide:
                  SupabaseService,

                useValue: {
                  createAdminClient:
                    () => ({
                      from:
                        (
                          table:
                            string,
                        ) => {
                          if (
                            table !==
                            'outing_payment_intents'
                          ) {
                            throw new Error(
                              `Unexpected table ${table}`,
                            );
                          }

                          return {
                            select,
                          };
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
            ],
          }).compile();

        service =
          module.get(
            OutingsPaymentReceiptsService,
          );
      },
    );

    it('returns a completed receipt with Paystack fee information', async () => {
      maybeSingle.mockResolvedValue({
        data: {
          id:
            paymentId,

          outing_id:
            outingId,

          selected_member_id:
            memberId,

          payer_user_id:
            userId,

          amount_minor:
            100000,

          currency:
            'NGN',

          method_id:
            'card',

          provider:
            'paystack',

          provider_reference:
            'MOVA-test-reference',

          provider_transaction_id:
            '6608716906',

          provider_amount_minor:
            101523,

          provider_requested_amount_minor:
            100000,

          provider_currency:
            'NGN',

          provider_channel:
            'card',

          provider_paid_at:
            '2026-09-29T22:49:22.000Z',

          provider_verified_at:
            '2026-09-29T22:49:23.000Z',

          completed_at:
            '2026-09-29T22:49:22.000Z',

          status:
            'completed',

          reconciliation_state:
            'none',

          reconciliation_resolution:
            null,
        },

        error:
          null,
      });

      await expect(
        service.getReceipt(
          userId,
          outingId,
        ),
      ).resolves.toEqual({
        receiptId:
          paymentId,

        outing: {
          id:
            outingId,

          title:
            'Dinner',

          location:
            'Lagos',
        },

        status:
          'completed',

        payer: {
          memberId,

          displayName:
            'Samuel',
        },

        requestedAmountMinor:
          100000,

        chargedAmountMinor:
          101523,

        feeAmountMinor:
          1523,

        currency:
          'NGN',

        methodId:
          'card',

        provider:
          'paystack',

        providerReference:
          'MOVA-test-reference',

        providerTransactionId:
          '6608716906',

        providerChannel:
          'card',

        paidAt:
          '2026-09-29T22:49:22.000Z',

        verifiedAt:
          '2026-09-29T22:49:23.000Z',

        reconciliation: {
          state:
            'none',

          resolution:
            null,
        },
      });
    });

    it('returns 404 when the outing has no completed payment', async () => {
      await expect(
        service.getReceipt(
          userId,
          outingId,
        ),
      ).rejects.toMatchObject({
        status:
          404,

        message:
          'A completed payment receipt is not available for this outing.',
      });
    });

    it('verifies outing membership before exposing the receipt', async () => {
      outingsGet.mockRejectedValue({
        status:
          404,

        message:
          'Outing not found.',
      });

      await expect(
        service.getReceipt(
          userId,
          outingId,
        ),
      ).rejects.toMatchObject({
        status:
          404,
      });

      expect(
        select,
      ).not.toHaveBeenCalled();
    });

    it('falls back to MOVA amount when old completed data has no provider amount', async () => {
      maybeSingle.mockResolvedValue({
        data: {
          id:
            paymentId,

          outing_id:
            outingId,

          selected_member_id:
            memberId,

          payer_user_id:
            userId,

          amount_minor:
            100000,

          currency:
            'NGN',

          method_id:
            'card',

          provider:
            'paystack',

          provider_reference:
            'MOVA-old-reference',

          provider_transaction_id:
            '123456',

          provider_amount_minor:
            null,

          provider_requested_amount_minor:
            null,

          provider_currency:
            null,

          provider_channel:
            'card',

          provider_paid_at:
            '2026-09-29T22:49:22.000Z',

          provider_verified_at:
            null,

          completed_at:
            '2026-09-29T22:49:22.000Z',

          status:
            'completed',

          reconciliation_state:
            'none',

          reconciliation_resolution:
            null,
        },

        error:
          null,
      });

      const result =
        await service.getReceipt(
          userId,
          outingId,
        );

      expect(
        result.requestedAmountMinor,
      ).toBe(
        100000,
      );

      expect(
        result.chargedAmountMinor,
      ).toBe(
        100000,
      );

      expect(
        result.feeAmountMinor,
      ).toBe(
        0,
      );
    });
  },
);