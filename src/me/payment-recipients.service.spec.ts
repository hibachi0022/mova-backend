import { Test } from '@nestjs/testing';
import { SupabaseService } from '../supabase/supabase.service';
import { PaymentRecipientsService } from './payment-recipients.service';

describe(
  'PaymentRecipientsService',
  () => {
    let service:
      PaymentRecipientsService;

    const from =
      jest.fn();

    const userA =
      '11111111-1111-4111-8111-111111111111';

    const userB =
      '22222222-2222-4222-8222-222222222222';

    const userC =
      '33333333-3333-4333-8333-333333333333';

    beforeEach(async () => {
      jest.resetAllMocks();

      const module =
        await Test.createTestingModule({
          providers: [
            PaymentRecipientsService,
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
          PaymentRecipientsService,
        );
    });

    it('returns no recipients when the user has no accepted friends', async () => {
      from.mockImplementation(
        (table: string) => {
          if (
            table ===
            'friendships'
          ) {
            return {
              select: jest
                .fn()
                .mockReturnValue({
                  or: jest
                    .fn()
                    .mockResolvedValue({
                      data: [],
                      error:
                        null,
                    }),
                }),
            };
          }

          if (
            table ===
            'user_blocks'
          ) {
            return {
              select: jest
                .fn()
                .mockReturnValue({
                  or: jest
                    .fn()
                    .mockResolvedValue({
                      data: [],
                      error:
                        null,
                    }),
                }),
            };
          }

          throw new Error(
            `Unexpected table ${table}`,
          );
        },
      );

      await expect(
        service.listRecipients(
          userA,
        ),
      ).resolves.toEqual({
        recipients: [],
      });
    });

    it('returns accepted friends as payment recipients', async () => {
      from.mockImplementation(
        (table: string) => {
          if (
            table ===
            'friendships'
          ) {
            return {
              select: jest
                .fn()
                .mockReturnValue({
                  or: jest
                    .fn()
                    .mockResolvedValue({
                      data: [
                        {
                          user_a_id:
                            userA,
                          user_b_id:
                            userB,
                        },
                        {
                          user_a_id:
                            userC,
                          user_b_id:
                            userA,
                        },
                      ],
                      error:
                        null,
                    }),
                }),
            };
          }

          if (
            table ===
            'user_blocks'
          ) {
            return {
              select: jest
                .fn()
                .mockReturnValue({
                  or: jest
                    .fn()
                    .mockResolvedValue({
                      data: [],
                      error:
                        null,
                    }),
                }),
            };
          }

          if (
            table ===
            'profiles'
          ) {
            return {
              select: jest
                .fn()
                .mockReturnValue({
                  in: jest
                    .fn()
                    .mockResolvedValue({
                      data: [
                        {
                          user_id:
                            userB,
                          display_name:
                            'Peter',
                          username:
                            'peter',
                        },
                        {
                          user_id:
                            userC,
                          display_name:
                            'Queen',
                          username:
                            'queen',
                        },
                      ],
                      error:
                        null,
                    }),
                }),
            };
          }

          throw new Error(
            `Unexpected table ${table}`,
          );
        },
      );

      const result =
        await service.listRecipients(
          userA,
        );

      expect(result).toEqual({
        recipients: [
          {
            id: userB,
            displayName:
              'Peter',
            username:
              'peter',
          },
          {
            id: userC,
            displayName:
              'Queen',
            username:
              'queen',
          },
        ],
      });
    });

    it('excludes a blocked relationship defensively', async () => {
      from.mockImplementation(
        (table: string) => {
          if (
            table ===
            'friendships'
          ) {
            return {
              select: jest
                .fn()
                .mockReturnValue({
                  or: jest
                    .fn()
                    .mockResolvedValue({
                      data: [
                        {
                          user_a_id:
                            userA,
                          user_b_id:
                            userB,
                        },
                        {
                          user_a_id:
                            userA,
                          user_b_id:
                            userC,
                        },
                      ],
                      error:
                        null,
                    }),
                }),
            };
          }

          if (
            table ===
            'user_blocks'
          ) {
            return {
              select: jest
                .fn()
                .mockReturnValue({
                  or: jest
                    .fn()
                    .mockResolvedValue({
                      data: [
                        {
                          blocker_id:
                            userC,
                          blocked_id:
                            userA,
                        },
                      ],
                      error:
                        null,
                    }),
                }),
            };
          }

          if (
            table ===
            'profiles'
          ) {
            return {
              select: jest
                .fn()
                .mockReturnValue({
                  in: jest
                    .fn()
                    .mockResolvedValue({
                      data: [
                        {
                          user_id:
                            userB,
                          display_name:
                            'Peter',
                          username:
                            'peter',
                        },
                      ],
                      error:
                        null,
                    }),
                }),
            };
          }

          throw new Error(
            `Unexpected table ${table}`,
          );
        },
      );

      const result =
        await service.listRecipients(
          userA,
        );

      expect(result).toEqual({
        recipients: [
          {
            id: userB,
            displayName:
              'Peter',
            username:
              'peter',
          },
        ],
      });
    });

    it('sorts recipients by display name', async () => {
      from.mockImplementation(
        (table: string) => {
          if (
            table ===
            'friendships'
          ) {
            return {
              select: jest
                .fn()
                .mockReturnValue({
                  or: jest
                    .fn()
                    .mockResolvedValue({
                      data: [
                        {
                          user_a_id:
                            userA,
                          user_b_id:
                            userB,
                        },
                        {
                          user_a_id:
                            userA,
                          user_b_id:
                            userC,
                        },
                      ],
                      error:
                        null,
                    }),
                }),
            };
          }

          if (
            table ===
            'user_blocks'
          ) {
            return {
              select: jest
                .fn()
                .mockReturnValue({
                  or: jest
                    .fn()
                    .mockResolvedValue({
                      data: [],
                      error:
                        null,
                    }),
                }),
            };
          }

          if (
            table ===
            'profiles'
          ) {
            return {
              select: jest
                .fn()
                .mockReturnValue({
                  in: jest
                    .fn()
                    .mockResolvedValue({
                      data: [
                        {
                          user_id:
                            userB,
                          display_name:
                            'Zainab',
                          username:
                            'zainab',
                        },
                        {
                          user_id:
                            userC,
                          display_name:
                            'Ada',
                          username:
                            'ada',
                        },
                      ],
                      error:
                        null,
                    }),
                }),
            };
          }

          throw new Error(
            `Unexpected table ${table}`,
          );
        },
      );

      const result =
        await service.listRecipients(
          userA,
        );

      expect(
        result.recipients.map(
          (recipient) =>
            recipient.displayName,
        ),
      ).toEqual([
        'Ada',
        'Zainab',
      ]);
    });

    it('returns 503 when friendship data cannot be loaded', async () => {
      from.mockImplementation(
        (table: string) => {
          if (
            table ===
            'friendships'
          ) {
            return {
              select: jest
                .fn()
                .mockReturnValue({
                  or: jest
                    .fn()
                    .mockResolvedValue({
                      data: null,
                      error: {
                        message:
                          'database unavailable',
                      },
                    }),
                }),
            };
          }

          if (
            table ===
            'user_blocks'
          ) {
            return {
              select: jest
                .fn()
                .mockReturnValue({
                  or: jest
                    .fn()
                    .mockResolvedValue({
                      data: [],
                      error:
                        null,
                    }),
                }),
            };
          }

          throw new Error(
            `Unexpected table ${table}`,
          );
        },
      );

      await expect(
        service.listRecipients(
          userA,
        ),
      ).rejects.toMatchObject({
        status: 503,
      });
    });

    it('returns 503 when recipient profiles cannot be loaded', async () => {
      from.mockImplementation(
        (table: string) => {
          if (
            table ===
            'friendships'
          ) {
            return {
              select: jest
                .fn()
                .mockReturnValue({
                  or: jest
                    .fn()
                    .mockResolvedValue({
                      data: [
                        {
                          user_a_id:
                            userA,
                          user_b_id:
                            userB,
                        },
                      ],
                      error:
                        null,
                    }),
                }),
            };
          }

          if (
            table ===
            'user_blocks'
          ) {
            return {
              select: jest
                .fn()
                .mockReturnValue({
                  or: jest
                    .fn()
                    .mockResolvedValue({
                      data: [],
                      error:
                        null,
                    }),
                }),
            };
          }

          if (
            table ===
            'profiles'
          ) {
            return {
              select: jest
                .fn()
                .mockReturnValue({
                  in: jest
                    .fn()
                    .mockResolvedValue({
                      data: null,
                      error: {
                        message:
                          'database unavailable',
                      },
                    }),
                }),
            };
          }

          throw new Error(
            `Unexpected table ${table}`,
          );
        },
      );

      await expect(
        service.listRecipients(
          userA,
        ),
      ).rejects.toMatchObject({
        status: 503,
      });
    });
  },
);