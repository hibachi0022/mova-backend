import { Test } from '@nestjs/testing';
import { SupabaseService } from '../supabase/supabase.service';
import { SocialService } from './social.service';

describe('SocialService', () => {
  let service: SocialService;

  const from = jest.fn();

  beforeEach(async () => {
    jest.resetAllMocks();

    const module =
      await Test.createTestingModule({
        providers: [
          SocialService,
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
      module.get(SocialService);
  });

  it('returns social settings', async () => {
    const single =
      jest.fn().mockResolvedValue({
        data: {
          username: 'samuel',
          is_discoverable: true,
        },
        error: null,
      });

    const eq =
      jest.fn().mockReturnValue({
        single,
      });

    const select =
      jest.fn().mockReturnValue({
        eq,
      });

    from.mockReturnValue({
      select,
    });

    const result =
      await service.getSettings(
        '11111111-1111-4111-8111-111111111111',
      );

    expect(result).toEqual({
      username: 'samuel',
      isDiscoverable: true,
    });
  });

  it('rejects an empty social-settings update', async () => {
    await expect(
      service.updateSettings(
        '11111111-1111-4111-8111-111111111111',
        {},
      ),
    ).rejects.toMatchObject({
      status: 400,
    });

    expect(from).not.toHaveBeenCalled();
  });

  it('updates username and discoverability', async () => {
    const single =
      jest.fn().mockResolvedValue({
        data: {
          username: 'newhandle',
          is_discoverable: true,
        },
        error: null,
      });

    const select =
      jest.fn().mockReturnValue({
        single,
      });

    const eq =
      jest.fn().mockReturnValue({
        select,
      });

    const update =
      jest.fn().mockReturnValue({
        eq,
      });

    from.mockReturnValue({
      update,
    });

    const result =
      await service.updateSettings(
        '11111111-1111-4111-8111-111111111111',
        {
          username: 'newhandle',
          isDiscoverable: true,
        },
      );

    expect(update).toHaveBeenCalledWith({
      username: 'newhandle',
      is_discoverable: true,
    });

    expect(result).toEqual({
      username: 'newhandle',
      isDiscoverable: true,
    });
  });

  it('can turn discoverability off without changing username', async () => {
    const single =
      jest.fn().mockResolvedValue({
        data: {
          username: 'samuel',
          is_discoverable: false,
        },
        error: null,
      });

    const select =
      jest.fn().mockReturnValue({
        single,
      });

    const eq =
      jest.fn().mockReturnValue({
        select,
      });

    const update =
      jest.fn().mockReturnValue({
        eq,
      });

    from.mockReturnValue({
      update,
    });

    const result =
      await service.updateSettings(
        '11111111-1111-4111-8111-111111111111',
        {
          isDiscoverable: false,
        },
      );

    expect(update).toHaveBeenCalledWith({
      is_discoverable: false,
    });

    expect(result).toEqual({
      username: 'samuel',
      isDiscoverable: false,
    });
  });

  it('returns 409 when username is already taken', async () => {
    const single =
      jest.fn().mockResolvedValue({
        data: null,
        error: {
          code: '23505',
        },
      });

    const select =
      jest.fn().mockReturnValue({
        single,
      });

    const eq =
      jest.fn().mockReturnValue({
        select,
      });

    const update =
      jest.fn().mockReturnValue({
        eq,
      });

    from.mockReturnValue({
      update,
    });

    await expect(
      service.updateSettings(
        '11111111-1111-4111-8111-111111111111',
        {
          username: 'taken',
        },
      ),
    ).rejects.toMatchObject({
      status: 409,
    });
  });

  it('returns 503 when social settings cannot be loaded', async () => {
    const single =
      jest.fn().mockResolvedValue({
        data: null,
        error: {
          message: 'database unavailable',
        },
      });

    const eq =
      jest.fn().mockReturnValue({
        single,
      });

    const select =
      jest.fn().mockReturnValue({
        eq,
      });

    from.mockReturnValue({
      select,
    });

    await expect(
      service.getSettings(
        '11111111-1111-4111-8111-111111111111',
      ),
    ).rejects.toMatchObject({
      status: 503,
    });
  });
});