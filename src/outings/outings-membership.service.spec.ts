import { Test } from '@nestjs/testing';
import { SupabaseService } from '../supabase/supabase.service';
import {
  OutingResponse,
  OutingsService,
} from './outings.service';

describe(
  'OutingsService membership and invitations',
  () => {
    let service:
      OutingsService;

    const rpc =
      jest.fn();

    const userA =
      '11111111-1111-4111-8111-111111111111';

    const userB =
      '22222222-2222-4222-8222-222222222222';

    const outingA =
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    const outingResponse:
      OutingResponse = {
        id: outingA,
        title:
          'Dinner',
        location:
          'Lagos',
        startsAt:
          '2099-10-01T18:00:00.000Z',
        currency:
          'NGN',
        amountMinor:
          250000,
        members: [],
      };

    beforeEach(
      async () => {
        jest.resetAllMocks();

        const module =
          await Test.createTestingModule(
            {
              providers: [
                OutingsService,
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
            },
          ).compile();

        service =
          module.get(
            OutingsService,
          );
      },
    );

    it('adds a guest through the database RPC', async () => {
      rpc.mockResolvedValue({
        data: {
          status:
            'added',
          memberId:
            'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        },
        error: null,
      });

      jest
        .spyOn(
          service,
          'get',
        )
        .mockResolvedValue(
          outingResponse,
        );

      const result =
        await service.addGuest(
          userA,
          outingA,
          {
            displayName:
              'Peter',
            optedIn:
              false,
          },
        );

      expect(
        rpc,
      ).toHaveBeenCalledWith(
        'add_outing_guest',
        {
          p_actor_id:
            userA,
          p_outing_id:
            outingA,
          p_display_name:
            'Peter',
        },
      );

      expect(result).toBe(
        outingResponse,
      );
    });

    it('rejects guest creation when actor lacks host permission', async () => {
      rpc.mockResolvedValue({
        data: {
          status:
            'forbidden',
        },
        error: null,
      });

      await expect(
        service.addGuest(
          userB,
          outingA,
          {
            displayName:
              'Guest',
            optedIn:
              false,
          },
        ),
      ).rejects.toMatchObject({
        status: 403,
      });
    });

    it('creates a hashed invitation code', async () => {
      rpc.mockImplementation(
        (
          name: string,
          args: {
            p_expires_at:
              string;
          },
        ) => {
          expect(name).toBe(
            'create_outing_join_code',
          );

          return Promise.resolve({
            data: {
              status:
                'created',
              codeId:
                'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              expiresAt:
                args.p_expires_at,
            },
            error: null,
          });
        },
      );

      const result =
        await service.createInvite(
          userA,
          outingA,
        );

      expect(
        result.code,
      ).toMatch(
        /^[A-F0-9]{10}$/,
      );

      expect(
        result.joinUrl,
      ).toBe(
        `mova://join?code=${result.code}`,
      );

      expect(
        Date.parse(
          result.expiresAt,
        ),
      ).toBeGreaterThan(
        Date.now(),
      );

      expect(
        rpc,
      ).toHaveBeenCalledWith(
        'create_outing_join_code',
        expect.objectContaining({
          p_actor_id:
            userA,
          p_outing_id:
            outingA,
          p_code_hash:
            expect.stringMatching(
              /^[0-9a-f]{64}$/,
            ),
          p_code_hint:
            expect.stringMatching(
              /^[A-F0-9]{4}$/,
            ),
          p_max_uses:
            100,
        }),
      );
    });

    it('returns 404 for an invalid or expired invite lookup', async () => {
      rpc.mockResolvedValue({
        data: {
          status:
            'invalid',
        },
        error: null,
      });

      await expect(
        service.lookupInvite(
          'AAAAAAAAAA',
        ),
      ).rejects.toMatchObject({
        status: 404,
      });
    });

    it('joins a valid invitation and reloads the outing', async () => {
      rpc.mockResolvedValue({
        data: {
          status:
            'joined',
          outingId:
            outingA,
          memberId:
            'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        },
        error: null,
      });

      const getSpy =
        jest
          .spyOn(
            service,
            'get',
          )
          .mockResolvedValue(
            outingResponse,
          );

      const result =
        await service.joinInvite(
          userB,
          'A1B2C3D4E5',
        );

      expect(
        rpc,
      ).toHaveBeenCalledWith(
        'join_outing_with_code',
        {
          p_code_hash:
            expect.stringMatching(
              /^[0-9a-f]{64}$/,
            ),
          p_user_id:
            userB,
        },
      );

      expect(
        getSpy,
      ).toHaveBeenCalledWith(
        userB,
        outingA,
      );

      expect(result).toBe(
        outingResponse,
      );
    });

    it('does not reveal block direction when joining is blocked', async () => {
      rpc.mockResolvedValue({
        data: {
          status:
            'blocked',
        },
        error: null,
      });

      await expect(
        service.joinInvite(
          userB,
          'A1B2C3D4E5',
        ),
      ).rejects.toMatchObject({
        status: 409,
        message:
          'Unable to join this outing with this invitation.',
      });
    });

    it('updates the current members payer-selection consent', async () => {
      rpc.mockResolvedValue({
        data: {
          status:
            'updated',
          memberId:
            'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          optedIn:
            true,
        },
        error: null,
      });

      jest
        .spyOn(
          service,
          'get',
        )
        .mockResolvedValue(
          outingResponse,
        );

      await expect(
        service.setConsent(
          userB,
          outingA,
          true,
        ),
      ).resolves.toBe(
        outingResponse,
      );

      expect(
        rpc,
      ).toHaveBeenCalledWith(
        'set_outing_member_consent',
        {
          p_user_id:
            userB,
          p_outing_id:
            outingA,
          p_opted_in:
            true,
        },
      );
    });
  },
);