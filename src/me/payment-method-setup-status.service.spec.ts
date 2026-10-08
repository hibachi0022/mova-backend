import { Test } from '@nestjs/testing';
import { SupabaseService } from '../supabase/supabase.service';
import { PaymentMethodSetupStatusService } from './payment-method-setup-status.service';

type DatabaseResult = {
  data:
    unknown;

  error:
    unknown;
};

type SetupQuery = {
  select:
    jest.Mock;

  eq:
    jest.Mock;

  order:
    jest.Mock;

  limit:
    jest.Mock;

  maybeSingle:
    jest.Mock;
};

describe(
  'PaymentMethodSetupStatusService',
  () => {
    let service:
      PaymentMethodSetupStatusService;

    const userId =
      '11111111-1111-4111-8111-111111111111';

    let result:
      DatabaseResult;

    const from =
      jest.fn();

    function createQuery():
      SetupQuery {
      const query =
        {} as
          SetupQuery;

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

      query.maybeSingle =
        jest.fn(
          async () =>
            result,
        );

      return query;
    }

    beforeEach(
      async () => {
        jest.resetAllMocks();

        result = {
          data:
            null,

          error:
            null,
        };

        from.mockImplementation(
          (
            table:
              string,
          ) => {
            if (
              table !==
              'payment_method_setups'
            ) {
              throw new Error(
                `Unexpected table ${table}`,
              );
            }

            return createQuery();
          },
        );

        const module =
          await Test.createTestingModule({
            providers: [
              PaymentMethodSetupStatusService,

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
            PaymentMethodSetupStatusService,
          );
      },
    );

    it('returns none when the user has never started standalone card setup', async () => {
      await expect(
        service.getLatest(
          userId,
        ),
      ).resolves.toEqual({
        status:
          'none',
      });

      expect(
        from,
      ).toHaveBeenCalledWith(
        'payment_method_setups',
      );
    });

    it('maps a checkout-ready setup to awaiting payment', async () => {
      result = {
        data: {
          status:
            'checkout_ready',

          refund_status:
            'not_requested',

          created_at:
            '2026-10-08T10:00:00.000Z',

          completed_at:
            null,

          refund_requested_at:
            null,

          refunded_at:
            null,
        },

        error:
          null,
      };

      await expect(
        service.getLatest(
          userId,
        ),
      ).resolves.toEqual({
        status:
          'awaiting_payment',

        refundStatus:
          'not_requested',

        createdAt:
          '2026-10-08T10:00:00.000Z',
      });
    });

    it('returns verified while its automatic refund is pending', async () => {
      result = {
        data: {
          status:
            'completed',

          refund_status:
            'pending',

          created_at:
            '2026-10-08T10:00:00.000Z',

          completed_at:
            '2026-10-08T10:03:00.000Z',

          refund_requested_at:
            '2026-10-08T10:03:05.000Z',

          refunded_at:
            null,
        },

        error:
          null,
      };

      await expect(
        service.getLatest(
          userId,
        ),
      ).resolves.toEqual({
        status:
          'verified',

        refundStatus:
          'pending',

        createdAt:
          '2026-10-08T10:00:00.000Z',

        completedAt:
          '2026-10-08T10:03:00.000Z',

        refundRequestedAt:
          '2026-10-08T10:03:05.000Z',
      });
    });

    it('returns verified after the verification refund is processed', async () => {
      result = {
        data: {
          status:
            'completed',

          refund_status:
            'processed',

          created_at:
            '2026-10-08T10:00:00.000Z',

          completed_at:
            '2026-10-08T10:03:00.000Z',

          refund_requested_at:
            '2026-10-08T10:03:05.000Z',

          refunded_at:
            '2026-10-08T10:10:00.000Z',
        },

        error:
          null,
      };

      await expect(
        service.getLatest(
          userId,
        ),
      ).resolves.toEqual({
        status:
          'verified',

        refundStatus:
          'processed',

        createdAt:
          '2026-10-08T10:00:00.000Z',

        completedAt:
          '2026-10-08T10:03:00.000Z',

        refundRequestedAt:
          '2026-10-08T10:03:05.000Z',

        refundedAt:
          '2026-10-08T10:10:00.000Z',
      });
    });

    it('returns failed while a charged verification is still being refunded', async () => {
      result = {
        data: {
          status:
            'failed',

          refund_status:
            'processing',

          created_at:
            '2026-10-08T10:00:00.000Z',

          completed_at:
            null,

          refund_requested_at:
            '2026-10-08T10:03:05.000Z',

          refunded_at:
            null,
        },

        error:
          null,
      };

      await expect(
        service.getLatest(
          userId,
        ),
      ).resolves.toEqual({
        status:
          'failed',

        refundStatus:
          'processing',

        createdAt:
          '2026-10-08T10:00:00.000Z',

        refundRequestedAt:
          '2026-10-08T10:03:05.000Z',
      });
    });

    it('returns 503 when card setup status cannot be loaded', async () => {
      result = {
        data:
          null,

        error: {
          message:
            'database unavailable',
        },
      };

      await expect(
        service.getLatest(
          userId,
        ),
      ).rejects.toMatchObject({
        status:
          503,

        message:
          'Unable to load card setup status right now.',
      });
    });
  },
);