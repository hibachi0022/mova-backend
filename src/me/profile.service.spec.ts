import { Test } from '@nestjs/testing';
import type { User } from '@supabase/supabase-js';
import { SupabaseService } from '../supabase/supabase.service';
import { ProfileService } from './profile.service';

describe('ProfileService', () => {
  let service: ProfileService;

  const maybeSingle = jest.fn();
  const select = jest.fn();
  const eq = jest.fn();
  const update = jest.fn();
  const insert = jest.fn();
  const from = jest.fn();

  const authUser = {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'test@example.com',
    user_metadata: {
      display_name: 'Original Name',
    },
  } as unknown as User;

  beforeEach(async () => {
    jest.resetAllMocks();

    from.mockReturnValue({
      select,
      update,
      insert,
    });

    select.mockReturnValue({
      eq,
    });

    eq.mockReturnValue({
      maybeSingle,
      select,
    });

    update.mockReturnValue({
      eq,
    });

    insert.mockReturnValue({
      select,
    });

    const module =
      await Test.createTestingModule({
        providers: [
          ProfileService,
          {
            provide: SupabaseService,
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
      module.get(ProfileService);
  });

  it('returns an existing profile', async () => {
    maybeSingle.mockResolvedValue({
      data: {
        user_id: authUser.id,
        display_name:
          'Stored Name',
        phone:
          '+234 800 000 0000',
        avatar_url: null,
      },
      error: null,
    });

    const result =
      await service.getUser(
        authUser,
      );

    expect(result).toEqual({
      id: authUser.id,
      email: 'test@example.com',
      displayName:
        'Stored Name',
      phone:
        '+234 800 000 0000',
    });
  });

  it('omits empty optional fields', async () => {
    maybeSingle.mockResolvedValue({
      data: {
        user_id: authUser.id,
        display_name:
          'Stored Name',
        phone: null,
        avatar_url: null,
      },
      error: null,
    });

    const result =
      await service.getUser(
        authUser,
      );

    expect(result).toEqual({
      id: authUser.id,
      email: 'test@example.com',
      displayName:
        'Stored Name',
    });
  });

  it('rejects an empty update', async () => {
    await expect(
      service.updateUser(
        authUser,
        {},
      ),
    ).rejects.toMatchObject({
      status: 400,
    });
  });

  it('updates profile fields', async () => {
    const updateSingle =
      jest.fn().mockResolvedValue({
        data: {
          user_id: authUser.id,
          display_name:
            'Updated Name',
          phone:
            '+234 811 111 1111',
          avatar_url: null,
        },
        error: null,
      });

    const updateSelect =
      jest.fn().mockReturnValue({
        single: updateSingle,
      });

    const updateEq =
      jest.fn().mockReturnValue({
        select: updateSelect,
      });

    update.mockReturnValue({
      eq: updateEq,
    });

    const result =
      await service.updateUser(
        authUser,
        {
          displayName:
            'Updated Name',
          phone:
            '+234 811 111 1111',
        },
      );

    expect(update).toHaveBeenCalledWith({
      display_name:
        'Updated Name',
      phone:
        '+234 811 111 1111',
    });

    expect(result).toEqual({
      id: authUser.id,
      email: 'test@example.com',
      displayName:
        'Updated Name',
      phone:
        '+234 811 111 1111',
    });
  });

  it('can clear the saved phone number', async () => {
    const updateSingle =
      jest.fn().mockResolvedValue({
        data: {
          user_id: authUser.id,
          display_name:
            'Original Name',
          phone: null,
          avatar_url: null,
        },
        error: null,
      });

    const updateSelect =
      jest.fn().mockReturnValue({
        single: updateSingle,
      });

    const updateEq =
      jest.fn().mockReturnValue({
        select: updateSelect,
      });

    update.mockReturnValue({
      eq: updateEq,
    });

    const result =
      await service.updateUser(
        authUser,
        {
          phone: null,
        },
      );

    expect(update).toHaveBeenCalledWith({
      phone: null,
    });

    expect(result).toEqual({
      id: authUser.id,
      email: 'test@example.com',
      displayName:
        'Original Name',
    });
  });
});