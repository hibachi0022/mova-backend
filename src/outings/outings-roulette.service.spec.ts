import { Test } from '@nestjs/testing';
import { SupabaseService } from '../supabase/supabase.service';
import { OutingsRouletteService } from './outings-roulette.service';

describe(
  'OutingsRouletteService',
  () => {
    let service:
      OutingsRouletteService;

    const rpc =
      jest.fn();

    const userId =
      '11111111-1111-4111-8111-111111111111';

    const outingId =
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    const memberId =
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    beforeEach(
      async () => {
        jest.resetAllMocks();

        const module =
          await Test.createTestingModule(
            {
              providers: [
                OutingsRouletteService,
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
            OutingsRouletteService,
          );
      },
    );

    it('returns the selected member', async () => {
      rpc.mockResolvedValue({
        data: {
          status:
            'selected',
          selectedMemberId:
            memberId,
          eligibleCount:
            2,
        },
        error: null,
      });

      await expect(
        service.spin(
          userId,
          outingId,
        ),
      ).resolves.toEqual({
        selectedMemberId:
          memberId,
      });

      expect(
        rpc,
      ).toHaveBeenCalledWith(
        'spin_outing_roulette',
        {
          p_actor_id:
            userId,
          p_outing_id:
            outingId,
        },
      );
    });

    it('returns the existing winner when already selected', async () => {
      rpc.mockResolvedValue({
        data: {
          status:
            'already_selected',
          selectedMemberId:
            memberId,
        },
        error: null,
      });

      await expect(
        service.spin(
          userId,
          outingId,
        ),
      ).resolves.toEqual({
        selectedMemberId:
          memberId,
      });
    });

    it('rejects a spin with fewer than two eligible members', async () => {
      rpc.mockResolvedValue({
        data: {
          status:
            'insufficient_members',
          eligibleCount:
            1,
        },
        error: null,
      });

      await expect(
        service.spin(
          userId,
          outingId,
        ),
      ).rejects.toMatchObject({
        status: 409,
        message:
          'At least two active members must opt into payer selection before spinning.',
      });
    });

    it('does not expose an outing to a non-member', async () => {
      rpc.mockResolvedValue({
        data: {
          status:
            'forbidden',
        },
        error: null,
      });

      await expect(
        service.spin(
          userId,
          outingId,
        ),
      ).rejects.toMatchObject({
        status: 404,
        message:
          'Outing not found.',
      });
    });

    it('returns 404 when the outing does not exist', async () => {
      rpc.mockResolvedValue({
        data: {
          status:
            'not_found',
        },
        error: null,
      });

      await expect(
        service.spin(
          userId,
          outingId,
        ),
      ).rejects.toMatchObject({
        status: 404,
      });
    });

    it('rejects roulette on an inactive outing', async () => {
      rpc.mockResolvedValue({
        data: {
          status:
            'inactive',
        },
        error: null,
      });

      await expect(
        service.spin(
          userId,
          outingId,
        ),
      ).rejects.toMatchObject({
        status: 409,
        message:
          'Payer selection is not available for this outing.',
      });
    });

    it('returns 503 when the database RPC fails', async () => {
      rpc.mockResolvedValue({
        data: null,
        error: {
          message:
            'database unavailable',
        },
      });

      await expect(
        service.spin(
          userId,
          outingId,
        ),
      ).rejects.toMatchObject({
        status: 503,
      });
    });
  },
);