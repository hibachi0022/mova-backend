import { Test } from '@nestjs/testing';
import { SupabaseService } from '../supabase/supabase.service';
import { PaymentHistoryService } from './payment-history.service';

type DatabaseResult = {
  data: unknown;
  error: unknown;
};

type MembershipQuery = {
  select: jest.Mock;
  eq: jest.Mock;
  is: jest.Mock;
};

type PaymentQuery = {
  select: jest.Mock;
  in: jest.Mock;
  eq: jest.Mock;
  order: jest.Mock;
  limit: jest.Mock;
};

type OutingQuery = {
  select: jest.Mock;
  in: jest.Mock;
};

describe(
  'PaymentHistoryService',
  () => {
    let service:
      PaymentHistoryService;

    const userId =
      '11111111-1111-4111-8111-111111111111';

    const outingId =
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    const paymentId =
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    let membershipResult:
      DatabaseResult;

    let paymentResult:
      DatabaseResult;

    let outingResult:
      DatabaseResult;

    const from =
      jest.fn();

    function createMembershipQuery():
      MembershipQuery {
      const query =
        {} as
          MembershipQuery;

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

      query.is =
        jest.fn(
          async () =>
            membershipResult,
        );

      return query;
    }

    function createPaymentQuery():
      PaymentQuery {
      const query =
        {} as
          PaymentQuery;

      query.select =
        jest.fn(
          () =>
            query,
        );

      query.in =
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
          async () =>
            paymentResult,
        );

      return query;
    }

    function createOutingQuery():
      OutingQuery {
      const query =
        {} as
          OutingQuery;

      query.select =
        jest.fn(
          () =>
            query,
        );

      query.in =
        jest.fn(
          async () =>
            outingResult,
        );

      return query;
    }

    beforeEach(
      async () => {
        jest.resetAllMocks();

        membershipResult = {
          data:
            [],

          error:
            null,
        };

        paymentResult = {
          data:
            [],

          error:
            null,
        };

        outingResult = {
          data:
            [],

          error:
            null,
        };

        from.mockImplementation(
          (
            table:
              string,
          ) => {
            if (
              table ===
              'outing_members'
            ) {
              return createMembershipQuery();
            }

            if (
              table ===
              'outing_payment_intents'
            ) {
              return createPaymentQuery();
            }

            if (
              table ===
              'outings'
            ) {
              return createOutingQuery();
            }

            throw new Error(
              `Unexpected table ${table}`,
            );
          },
        );

        const module =
          await Test.createTestingModule({
            providers: [
              PaymentHistoryService,

              {
                provide:
                  SupabaseService,

                useValue: {
                  createAdminClient:
                    () => ({
                      from,
                    }),
                },
              },
            ],
          }).compile();

        service =
          module.get(
            PaymentHistoryService,
          );
      },
    );

    it('returns an empty history when the user has no active outings', async () => {
      await expect(
        service.list(
          userId,
        ),
      ).resolves.toEqual({
        payments:
          [],
      });

      expect(
        from,
      ).toHaveBeenCalledTimes(
        1,
      );

      expect(
        from,
      ).toHaveBeenCalledWith(
        'outing_members',
      );
    });

    it('returns trusted completed payment history', async () => {
      membershipResult = {
        data: [
          {
            outing_id:
              outingId,
          },
        ],

        error:
          null,
      };

      paymentResult = {
        data: [
          {
            id:
              paymentId,

            outing_id:
              outingId,

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
              'MOVA-history-test',

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

            completed_at:
              '2026-09-29T22:49:22.000Z',
          },
        ],

        error:
          null,
      };

      outingResult = {
        data: [
          {
            id:
              outingId,

            title:
              'Dinner',

            location:
              'Lagos',

            starts_at:
              '2026-10-01T18:00:00.000Z',
          },
        ],

        error:
          null,
      };

      await expect(
        service.list(
          userId,
        ),
      ).resolves.toEqual({
        payments: [
          {
            receiptId:
              paymentId,

            outing: {
              id:
                outingId,

              title:
                'Dinner',

              location:
                'Lagos',

              startsAt:
                '2026-10-01T18:00:00.000Z',
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
              'MOVA-history-test',

            providerTransactionId:
              '6608716906',

            providerChannel:
              'card',

            paidAt:
              '2026-09-29T22:49:22.000Z',

            isPayer:
              true,
          },
        ],
      });

      expect(
        from,
      ).toHaveBeenCalledWith(
        'outing_members',
      );

      expect(
        from,
      ).toHaveBeenCalledWith(
        'outing_payment_intents',
      );

      expect(
        from,
      ).toHaveBeenCalledWith(
        'outings',
      );
    });

    it('shows when another outing member was the payer', async () => {
      membershipResult = {
        data: [
          {
            outing_id:
              outingId,
          },
        ],

        error:
          null,
      };

      paymentResult = {
        data: [
          {
            id:
              paymentId,

            outing_id:
              outingId,

            payer_user_id:
              '22222222-2222-4222-8222-222222222222',

            amount_minor:
              500000,

            currency:
              'NGN',

            method_id:
              'card',

            provider:
              'paystack',

            provider_reference:
              'MOVA-other-payer',

            provider_transaction_id:
              '6608716907',

            provider_amount_minor:
              507614,

            provider_requested_amount_minor:
              500000,

            provider_currency:
              'NGN',

            provider_channel:
              'card',

            provider_paid_at:
              '2026-09-29T21:00:00.000Z',

            completed_at:
              '2026-09-29T21:00:00.000Z',
          },
        ],

        error:
          null,
      };

      outingResult = {
        data: [
          {
            id:
              outingId,

            title:
              'Lunch',

            location:
              'Abuja',

            starts_at:
              '2026-10-02T12:00:00.000Z',
          },
        ],

        error:
          null,
      };

      const result =
        await service.list(
          userId,
        );

      expect(
        result.payments,
      ).toHaveLength(
        1,
      );

      expect(
        result.payments[0]
          .isPayer,
      ).toBe(
        false,
      );

      expect(
        result.payments[0]
          .outing.title,
      ).toBe(
        'Lunch',
      );
    });

    it('returns a service error when memberships cannot be loaded', async () => {
      membershipResult = {
        data:
          null,

        error: {
          message:
            'database unavailable',
        },
      };

      await expect(
        service.list(
          userId,
        ),
      ).rejects.toMatchObject({
        status:
          503,

        message:
          'Unable to load payment history right now.',
      });
    });

    it('returns a service error when completed payments cannot be loaded', async () => {
      membershipResult = {
        data: [
          {
            outing_id:
              outingId,
          },
        ],

        error:
          null,
      };

      paymentResult = {
        data:
          null,

        error: {
          message:
            'database unavailable',
        },
      };

      await expect(
        service.list(
          userId,
        ),
      ).rejects.toMatchObject({
        status:
          503,

        message:
          'Unable to load payment history right now.',
      });
    });

    it('returns a service error when outing details cannot be loaded', async () => {
      membershipResult = {
        data: [
          {
            outing_id:
              outingId,
          },
        ],

        error:
          null,
      };

      paymentResult = {
        data: [
          {
            id:
              paymentId,

            outing_id:
              outingId,

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
              'MOVA-history-test',

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

            completed_at:
              '2026-09-29T22:49:22.000Z',
          },
        ],

        error:
          null,
      };

      outingResult = {
        data:
          null,

        error: {
          message:
            'database unavailable',
        },
      };

      await expect(
        service.list(
          userId,
        ),
      ).rejects.toMatchObject({
        status:
          503,

        message:
          'Unable to load payment history right now.',
      });
    });
  },
);