import { Test } from '@nestjs/testing';
import { SupabaseService } from '../supabase/supabase.service';
import { PaymentMethodsService } from './payment-methods.service';

type DatabaseResult = {
  data: unknown;
  error: unknown;
};

type PaymentMethodQuery = {
  select: jest.Mock;
  eq: jest.Mock;
  is: jest.Mock;
};

describe(
  'PaymentMethodsService',
  () => {
    let service:
      PaymentMethodsService;

    const userId =
      '11111111-1111-4111-8111-111111111111';

    const paymentMethodId =
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    let result:
      DatabaseResult;

    const from =
      jest.fn();

    const rpc =
      jest.fn();

    function createQuery():
      PaymentMethodQuery {
      const query =
        {} as
          PaymentMethodQuery;

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
            result,
        );

      return query;
    }

    beforeEach(
      async () => {
        jest.resetAllMocks();

        result = {
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
              table !==
              'payment_methods'
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
              PaymentMethodsService,

              {
                provide:
                  SupabaseService,

                useValue: {
                  createAdminClient:
                    () => ({
                      from,
                      rpc,
                    }),
                },
              },
            ],
          }).compile();

        service =
          module.get(
            PaymentMethodsService,
          );
      },
    );

    it('returns an empty list when the user has no saved payment methods', async () => {
      await expect(
        service.list(
          userId,
        ),
      ).resolves.toEqual({
        methods:
          [],
      });

      expect(
        from,
      ).toHaveBeenCalledWith(
        'payment_methods',
      );
    });

    it('returns only safe masked payment method fields', async () => {
      result = {
        data: [
          {
            id:
              paymentMethodId,

            network:
              'Visa',

            last4:
              '4081',

            is_default:
              false,

            created_at:
              '2026-09-29T10:00:00.000Z',
          },

          {
            id:
              'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',

            network:
              'Mastercard',

            last4:
              '4444',

            is_default:
              true,

            created_at:
              '2026-09-28T10:00:00.000Z',
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
        methods: [
          {
            id:
              'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',

            network:
              'mastercard',

            last4:
              '4444',

            isDefault:
              true,
          },

          {
            id:
              paymentMethodId,

            network:
              'visa',

            last4:
              '4081',

            isDefault:
              false,
          },
        ],
      });
    });

    it('returns 503 when payment methods cannot be loaded', async () => {
      result = {
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
          'Unable to load saved payment methods right now.',
      });
    });

    it('rejects an invalid masked card number', async () => {
      result = {
        data: [
          {
            id:
              paymentMethodId,

            network:
              'visa',

            last4:
              '12345',

            is_default:
              true,

            created_at:
              '2026-09-29T10:00:00.000Z',
          },
        ],

        error:
          null,
      };

      await expect(
        service.list(
          userId,
        ),
      ).rejects.toMatchObject({
        status:
          503,

        message:
          'A saved payment method could not be loaded safely.',
      });
    });

    it('sets an active saved card as the default', async () => {
      rpc.mockResolvedValue({
        data: {
          status:
            'updated',

          paymentMethodId,
        },

        error:
          null,
      });

      await expect(
        service.setDefault(
          userId,
          paymentMethodId,
        ),
      ).resolves.toEqual({
        status:
          'updated',

        paymentMethodId,
      });

      expect(
        rpc,
      ).toHaveBeenCalledWith(
        'set_default_payment_method',
        {
          p_user_id:
            userId,

          p_payment_method_id:
            paymentMethodId,
        },
      );
    });

    it('treats setting the existing default card as idempotent', async () => {
      rpc.mockResolvedValue({
        data: {
          status:
            'existing',

          paymentMethodId,
        },

        error:
          null,
      });

      await expect(
        service.setDefault(
          userId,
          paymentMethodId,
        ),
      ).resolves.toEqual({
        status:
          'updated',

        paymentMethodId,
      });
    });

    it('does not allow another user to set an unknown card as default', async () => {
      rpc.mockResolvedValue({
        data: {
          status:
            'not_found',
        },

        error:
          null,
      });

      await expect(
        service.setDefault(
          userId,
          paymentMethodId,
        ),
      ).rejects.toMatchObject({
        status:
          404,

        message:
          'Saved payment method not found.',
      });
    });

    it('does not allow a disabled card to become default', async () => {
      rpc.mockResolvedValue({
        data: {
          status:
            'unavailable',
        },

        error:
          null,
      });

      await expect(
        service.setDefault(
          userId,
          paymentMethodId,
        ),
      ).rejects.toMatchObject({
        status:
          409,

        message:
          'This saved payment method is no longer available.',
      });
    });

    it('removes a saved payment method without deleting payment history', async () => {
      rpc.mockResolvedValue({
        data: {
          status:
            'disabled',

          paymentMethodId,

          replacementDefaultId:
            null,
        },

        error:
          null,
      });

      await expect(
        service.remove(
          userId,
          paymentMethodId,
        ),
      ).resolves.toEqual({
        status:
          'removed',

        paymentMethodId,
      });

      expect(
        rpc,
      ).toHaveBeenCalledWith(
        'disable_payment_method',
        {
          p_user_id:
            userId,

          p_payment_method_id:
            paymentMethodId,
        },
      );
    });

    it('treats removing an already disabled card as idempotent', async () => {
      rpc.mockResolvedValue({
        data: {
          status:
            'existing',

          paymentMethodId,
        },

        error:
          null,
      });

      await expect(
        service.remove(
          userId,
          paymentMethodId,
        ),
      ).resolves.toEqual({
        status:
          'removed',

        paymentMethodId,
      });
    });

    it('does not allow a user to remove another users saved card', async () => {
      rpc.mockResolvedValue({
        data: {
          status:
            'not_found',
        },

        error:
          null,
      });

      await expect(
        service.remove(
          userId,
          paymentMethodId,
        ),
      ).rejects.toMatchObject({
        status:
          404,

        message:
          'Saved payment method not found.',
      });
    });

    it('returns 503 when payment-method management cannot be completed safely', async () => {
      rpc.mockResolvedValue({
        data:
          null,

        error: {
          message:
            'database unavailable',
        },
      });

      await expect(
        service.remove(
          userId,
          paymentMethodId,
        ),
      ).rejects.toMatchObject({
        status:
          503,

        message:
          'Unable to remove the saved payment method right now.',
      });
    });
  },
);