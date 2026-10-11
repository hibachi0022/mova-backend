import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { SupabaseService } from '../supabase/supabase.service';
import { ReceivingAccountsService } from './receiving-accounts.service';

describe(
  'ReceivingAccountsService provider errors',
  () => {
    let service:
      ReceivingAccountsService;

    const userId =
      '11111111-1111-4111-8111-111111111111';

    const rpc =
      jest.fn();

    const originalFetch =
      global.fetch;

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

    beforeEach(
      async () => {
        jest.resetAllMocks();

        global.fetch =
          jest.fn();

        const module =
          await Test.createTestingModule({
            providers: [
              ReceivingAccountsService,

              {
                provide:
                  ConfigService,

                useValue: {
                  get:
                    jest.fn(
                      (
                        key:
                          string,
                      ) =>
                        key ===
                        'PAYSTACK_SECRET_KEY'
                          ? 'sk_test_example'
                          : undefined,
                    ),
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
            ReceivingAccountsService,
          );
      },
    );

    afterAll(
      () => {
        global.fetch =
          originalFetch;
      },
    );

    it('returns a useful 429 when the Paystack test-mode live bank resolve limit is reached', async () => {
      const fetchMock =
        global.fetch as
          jest.Mock;

      fetchMock
        .mockResolvedValueOnce(
          response(
            200,
            {
              status:
                true,

              data: [
                {
                  name:
                    'Moniepoint MFB',

                  code:
                    '50515',

                  active:
                    true,

                  is_deleted:
                    false,

                  country:
                    'Nigeria',

                  currency:
                    'NGN',

                  type:
                    'nuban',
                },
              ],

              meta: {
                next:
                  null,
              },
            },
          ),
        )
        .mockResolvedValueOnce(
          response(
            429,
            {
              status:
                false,

              message:
                'Test mode daily limit of 3 live bank resolves exceeded. Use test bank codes 001 or upgrade to live mode.',
            },
          ),
        );

      await expect(
        service.resolve(
          userId,
          {
            country:
              'NG',

            bankCode:
              '50515',

            accountNumber:
              '0123456789',
          },
        ),
      ).rejects.toMatchObject({
        status:
          429,

        message:
          'Paystack test-mode bank verification limit reached. Use a Paystack test bank account and try again.',
      });

      expect(
        fetchMock,
      ).toHaveBeenCalledTimes(
        2,
      );

      expect(
        rpc,
      ).not.toHaveBeenCalled();
    });
  },
);