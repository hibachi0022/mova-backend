import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { SupabaseService } from '../supabase/supabase.service';
import { ReceivingAccountsService } from './receiving-accounts.service';

describe(
  'ReceivingAccountsService',
  () => {
    let service:
      ReceivingAccountsService;

    const userId =
      '11111111-1111-4111-8111-111111111111';

    const verificationId =
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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

    it('returns the Nigeria receiving-account market without contacting Paystack', () => {
      expect(
        service.markets(),
      ).toEqual({
        markets: [
          {
            country:
              'NG',

            name:
              'Nigeria',

            currency:
              'NGN',

            accountNumberMinLength:
              10,

            accountNumberMaxLength:
              10,

            accountNumberFormat:
              'numeric',

            accountNumberLabel:
              'Account number',
          },
        ],
      });

      expect(
        global.fetch,
      ).not.toHaveBeenCalled();
    });

    it('rejects unsupported receiving-account markets', async () => {
      await expect(
        service.banks(
          'US',
        ),
      ).rejects.toMatchObject({
        status:
          400,
      });

      expect(
        global.fetch,
      ).not.toHaveBeenCalled();
    });

    it('returns only active Nigerian NGN NUBAN banks sorted by name', async () => {
      (
        global.fetch as
          jest.Mock
      ).mockResolvedValueOnce(
        response(
          200,
          {
            status:
              true,

            data: [
              {
                name:
                  'Zenith Bank',

                code:
                  '057',

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

              {
                name:
                  'Access Bank',

                code:
                  '044',

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

              {
                name:
                  'Inactive Bank',

                code:
                  '999',

                active:
                  false,

                is_deleted:
                  false,

                country:
                  'Nigeria',

                currency:
                  'NGN',

                type:
                  'nuban',
              },

              {
                name:
                  'Mobile Wallet',

                code:
                  '998',

                active:
                  true,

                is_deleted:
                  false,

                country:
                  'Nigeria',

                currency:
                  'NGN',

                type:
                  'mobile_money',
              },
            ],

            meta: {
              next:
                null,
            },
          },
        ),
      );

      await expect(
        service.banks(
          'NG',
        ),
      ).resolves.toEqual({
        banks: [
          {
            code:
              '044',

            name:
              'Access Bank',
          },

          {
            code:
              '057',

            name:
              'Zenith Bank',
          },
        ],
      });
    });

    it('caches the supported bank list for repeated requests', async () => {
      (
        global.fetch as
          jest.Mock
      ).mockResolvedValueOnce(
        response(
          200,
          {
            status:
              true,

            data: [
              {
                name:
                  'Access Bank',

                code:
                  '044',

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
      );

      await service.banks(
        'NG',
      );

      await service.banks(
        'NG',
      );

      expect(
        global.fetch,
      ).toHaveBeenCalledTimes(
        1,
      );
    });

    it('resolves an account, creates a Paystack recipient and stores only masked receiving details', async () => {
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
                    'Access Bank',

                  code:
                    '044',

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
            200,
            {
              status:
                true,

              data: {
                account_number:
                  '0123456789',

                account_name:
                  'SAMUEL SIMON',
              },
            },
          ),
        )
        .mockResolvedValueOnce(
          response(
            200,
            {
              status:
                true,

              data: {
                active:
                  true,

                type:
                  'nuban',

                currency:
                  'NGN',

                recipient_code:
                  'RCP_testrecipient',

                details: {
                  account_number:
                    '0123456789',

                  account_name:
                    'SAMUEL SIMON',

                  bank_code:
                    '044',

                  bank_name:
                    'Access Bank',
                },
              },
            },
          ),
        );

      rpc.mockResolvedValue({
        data: {
          status:
            'created',

          verificationId,

          accountName:
            'SAMUEL SIMON',

          bankName:
            'Access Bank',

          last4:
            '6789',

          country:
            'NG',

          currency:
            'NGN',

          expiresAt:
            new Date(
              Date.now() +
                10 * 60_000,
            ).toISOString(),
        },

        error:
          null,
      });

      const result =
        await service.resolve(
          userId,
          {
            country:
              'NG',

            bankCode:
              '044',

            accountNumber:
              '0123456789',

            routingDetails:
              {},
          },
        );

      expect(
        result,
      ).toMatchObject({
        verificationId,

        accountName:
          'SAMUEL SIMON',

        bankName:
          'Access Bank',

        last4:
          '6789',

        country:
          'NG',

        currency:
          'NGN',
      });

      expect(
        fetchMock,
      ).toHaveBeenCalledTimes(
        3,
      );

      const [
        recipientUrl,
        recipientOptions,
      ] =
        fetchMock.mock
          .calls[2] as [
          string,
          RequestInit,
        ];

      expect(
        recipientUrl,
      ).toBe(
        'https://api.paystack.co/transferrecipient',
      );

      const recipientBody =
        JSON.parse(
          recipientOptions.body as
            string,
        ) as {
          type:
            string;

          name:
            string;

          account_number:
            string;

          bank_code:
            string;

          currency:
            string;
        };

      expect(
        recipientBody,
      ).toMatchObject({
        type:
          'nuban',

        name:
          'SAMUEL SIMON',

        account_number:
          '0123456789',

        bank_code:
          '044',

        currency:
          'NGN',
      });

      expect(
        rpc,
      ).toHaveBeenCalledWith(
        'record_receiving_account_verification',
        {
          p_user_id:
            userId,

          p_provider_recipient_code:
            'RCP_testrecipient',

          p_bank_code:
            '044',

          p_bank_name:
            'Access Bank',

          p_account_name:
            'SAMUEL SIMON',

          p_last4:
            '6789',
        },
      );

      const rpcArguments =
        rpc.mock
          .calls[0][1] as
          Record<
            string,
            unknown
          >;

      expect(
        JSON.stringify(
          rpcArguments,
        ),
      ).not.toContain(
        '0123456789',
      );
    });

    it('does not create a transfer recipient when Paystack cannot resolve the account', async () => {
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
                    'Access Bank',

                  code:
                    '044',

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
            422,
            {
              status:
                false,

              message:
                'Could not resolve account',
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
              '044',

            accountNumber:
              '0123456789',
          },
        ),
      ).rejects.toMatchObject({
        status:
          422,
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

    it('rejects a resolved account when the provider returns a different account number', async () => {
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
                    'Access Bank',

                  code:
                    '044',

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
            200,
            {
              status:
                true,

              data: {
                account_number:
                  '0000000000',

                account_name:
                  'OTHER ACCOUNT',
              },
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
              '044',

            accountNumber:
              '0123456789',
          },
        ),
      ).rejects.toMatchObject({
        status:
          503,
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

    it('does not store an invalid Paystack transfer recipient response', async () => {
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
                    'Access Bank',

                  code:
                    '044',

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
            200,
            {
              status:
                true,

              data: {
                account_number:
                  '0123456789',

                account_name:
                  'SAMUEL SIMON',
              },
            },
          ),
        )
        .mockResolvedValueOnce(
          response(
            200,
            {
              status:
                true,

              data: {
                active:
                  true,

                type:
                  'nuban',

                currency:
                  'NGN',

                recipient_code:
                  '',
              },
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
              '044',

            accountNumber:
              '0123456789',
          },
        ),
      ).rejects.toMatchObject({
        status:
          503,
      });

      expect(
        rpc,
      ).not.toHaveBeenCalled();
    });

    it('fails safely when the verified receiving account cannot be stored', async () => {
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
                    'Access Bank',

                  code:
                    '044',

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
            200,
            {
              status:
                true,

              data: {
                account_number:
                  '0123456789',

                account_name:
                  'SAMUEL SIMON',
              },
            },
          ),
        )
        .mockResolvedValueOnce(
          response(
            200,
            {
              status:
                true,

              data: {
                active:
                  true,

                type:
                  'nuban',

                currency:
                  'NGN',

                recipient_code:
                  'RCP_testrecipient',

                details: {
                  account_number:
                    '0123456789',

                  bank_code:
                    '044',
                },
              },
            },
          ),
        );

      rpc.mockResolvedValue({
        data:
          null,

        error: {
          message:
            'database unavailable',
        },
      });

      await expect(
        service.resolve(
          userId,
          {
            country:
              'NG',

            bankCode:
              '044',

            accountNumber:
              '0123456789',
          },
        ),
      ).rejects.toMatchObject({
        status:
          503,

        message:
          'The bank account was verified but could not be prepared for saving.',
      });
    });
  },
);