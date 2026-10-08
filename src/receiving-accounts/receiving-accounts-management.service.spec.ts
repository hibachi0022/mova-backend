import { Test } from '@nestjs/testing';
import { SupabaseService } from '../supabase/supabase.service';
import { ReceivingAccountsManagementService } from './receiving-accounts-management.service';

describe(
  'ReceivingAccountsManagementService',
  () => {
    let service:
      ReceivingAccountsManagementService;

    const userId =
      '11111111-1111-4111-8111-111111111111';

    const accountId =
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    const otherAccountId =
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    const verificationId =
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

    const rpc =
      jest.fn();

    const from =
      jest.fn();

    let listResult: {
      data:
        unknown;

      error:
        unknown;
    };

    function query() {
      const builder = {
        select:
          jest.fn(),

        eq:
          jest.fn(),

        is:
          jest.fn(),
      };

      builder.select.mockReturnValue(
        builder,
      );

      builder.eq.mockReturnValue(
        builder,
      );

      builder.is.mockImplementation(
        async () =>
          listResult,
      );

      return builder;
    }

    beforeEach(
      async () => {
        jest.resetAllMocks();

        listResult = {
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
              'receiving_accounts'
            ) {
              throw new Error(
                `Unexpected table ${table}`,
              );
            }

            return query();
          },
        );

        const module =
          await Test.createTestingModule({
            providers: [
              ReceivingAccountsManagementService,

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
            ReceivingAccountsManagementService,
          );
      },
    );

    it('lists active receiving accounts with the default first', async () => {
      listResult = {
        data: [
          {
            id:
              accountId,

            bank_name:
              'Access Bank',

            account_name:
              'SAMUEL SIMON',

            last4:
              '6789',

            country:
              'NG',

            currency:
              'NGN',

            initials:
              'SS',

            is_default:
              false,

            created_at:
              '2026-10-08T10:00:00.000Z',

            updated_at:
              '2026-10-08T11:00:00.000Z',
          },

          {
            id:
              otherAccountId,

            bank_name:
              'Zenith Bank',

            account_name:
              'SAMUEL SIMON',

            last4:
              '4321',

            country:
              'NG',

            currency:
              'NGN',

            initials:
              null,

            is_default:
              true,

            created_at:
              '2026-10-08T09:00:00.000Z',

            updated_at:
              '2026-10-08T09:00:00.000Z',
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
        accounts: [
          {
            id:
              otherAccountId,

            bankName:
              'Zenith Bank',

            accountName:
              'SAMUEL SIMON',

            last4:
              '4321',

            country:
              'NG',

            currency:
              'NGN',

            isDefault:
              true,
          },

          {
            id:
              accountId,

            bankName:
              'Access Bank',

            accountName:
              'SAMUEL SIMON',

            last4:
              '6789',

            country:
              'NG',

            currency:
              'NGN',

            initials:
              'SS',

            isDefault:
              false,
          },
        ],
      });
    });

    it('fails safely when receiving accounts cannot be loaded', async () => {
      listResult = {
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
          'Unable to load receiving accounts right now.',
      });
    });

    it('rejects unsafe receiving-account data from storage', async () => {
      listResult = {
        data: [
          {
            id:
              accountId,

            bank_name:
              'Access Bank',

            account_name:
              'SAMUEL SIMON',

            last4:
              '123',

            country:
              'NG',

            currency:
              'NGN',

            initials:
              null,

            is_default:
              true,

            created_at:
              '2026-10-08T10:00:00.000Z',

            updated_at:
              '2026-10-08T10:00:00.000Z',
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
      });
    });

    it('saves a verified receiving account using a hashed idempotency key', async () => {
      rpc.mockResolvedValue({
        data: {
          status:
            'saved',

          accountId,

          bankName:
            'Access Bank',

          accountName:
            'SAMUEL SIMON',

          last4:
            '6789',

          country:
            'NG',

          currency:
            'NGN',

          initials:
            'SS',

          isDefault:
            true,
        },

        error:
          null,
      });

      await expect(
        service.save(
          userId,
          {
            verificationId,

            initials:
              'ss',
          },
          'receiving-save-12345',
        ),
      ).resolves.toEqual({
        account: {
          id:
            accountId,

          bankName:
            'Access Bank',

          accountName:
            'SAMUEL SIMON',

          last4:
            '6789',

          country:
            'NG',

          currency:
            'NGN',

          initials:
            'SS',

          isDefault:
            true,
        },
      });

      expect(
        rpc,
      ).toHaveBeenCalledWith(
        'save_receiving_account',
        expect.objectContaining({
          p_user_id:
            userId,

          p_verification_id:
            verificationId,

          p_initials:
            'SS',
        }),
      );

      const args =
        rpc.mock
          .calls[0][1] as
          Record<
            string,
            unknown
          >;

      expect(
        args.p_idempotency_key_hash,
      ).toEqual(
        expect.stringMatching(
          /^[0-9a-f]{64}$/,
        ),
      );

      expect(
        args.p_idempotency_key_hash,
      ).not.toBe(
        'receiving-save-12345',
      );
    });

    it('rejects a missing or invalid save idempotency key before the database is called', async () => {
      await expect(
        service.save(
          userId,
          {
            verificationId,
          },
          'short',
        ),
      ).rejects.toMatchObject({
        status:
          400,
      });

      expect(
        rpc,
      ).not.toHaveBeenCalled();
    });

    it('reports an expired account verification without saving it', async () => {
      rpc.mockResolvedValue({
        data: {
          status:
            'expired',
        },

        error:
          null,
      });

      await expect(
        service.save(
          userId,
          {
            verificationId,
          },
          'receiving-save-expired',
        ),
      ).rejects.toMatchObject({
        status:
          409,
      });
    });

    it('sets an active receiving account as default', async () => {
      rpc.mockResolvedValue({
        data: {
          status:
            'updated',

          accountId,
        },

        error:
          null,
      });

      await expect(
        service.setDefault(
          userId,
          accountId,
        ),
      ).resolves.toEqual({
        status:
          'updated',

        accountId,
      });

      expect(
        rpc,
      ).toHaveBeenCalledWith(
        'set_default_receiving_account',
        {
          p_user_id:
            userId,

          p_receiving_account_id:
            accountId,
        },
      );
    });

    it('removes an account and returns the promoted replacement default', async () => {
      rpc.mockResolvedValue({
        data: {
          status:
            'disabled',

          accountId,

          replacementDefaultId:
            otherAccountId,
        },

        error:
          null,
      });

      await expect(
        service.remove(
          userId,
          accountId,
        ),
      ).resolves.toEqual({
        status:
          'removed',

        accountId,

        replacementDefaultId:
          otherAccountId,
      });

      expect(
        rpc,
      ).toHaveBeenCalledWith(
        'disable_receiving_account',
        {
          p_user_id:
            userId,

          p_receiving_account_id:
            accountId,
        },
      );
    });
  },
);