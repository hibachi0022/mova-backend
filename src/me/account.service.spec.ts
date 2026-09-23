import { Test } from '@nestjs/testing';
import type { User } from '@supabase/supabase-js';
import { SupabaseService } from '../supabase/supabase.service';
import { AccountService } from './account.service';

describe('AccountService', () => {
  let service: AccountService;

  const signInWithPassword =
    jest.fn();

  const deleteUser =
    jest.fn();

  const signOut =
    jest.fn();

  const authUser = {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'test@example.com',
    user_metadata: {},
  } as unknown as User;

  beforeEach(async () => {
    jest.resetAllMocks();

    signOut.mockResolvedValue({
      error: null,
    });

    const module =
      await Test.createTestingModule({
        providers: [
          AccountService,
          {
            provide:
              SupabaseService,
            useValue: {
              createClient:
                () => ({
                  auth: {
                    signInWithPassword,
                  },
                }),

              createAdminClient:
                () => ({
                  auth: {
                    admin: {
                      deleteUser,
                      signOut,
                    },
                  },
                }),
            },
          },
        ],
      }).compile();

    service =
      module.get(
        AccountService,
      );
  });

  function mockSuccessfulReauthentication() {
    signInWithPassword.mockResolvedValue({
      data: {
        session: {
          access_token:
            'temporary-access-token',
          refresh_token:
            'temporary-refresh-token',
        },
        user: {
          id: authUser.id,
          email:
            'test@example.com',
        },
      },
      error: null,
    });
  }

  it('rejects an account without an email address', async () => {
    const userWithoutEmail = {
      ...authUser,
      email: undefined,
    } as unknown as User;

    await expect(
      service.deleteAccount(
        userWithoutEmail,
        {
          currentPassword:
            'CurrentPassword123!',
        },
      ),
    ).rejects.toMatchObject({
      status: 400,
    });

    expect(
      signInWithPassword,
    ).not.toHaveBeenCalled();

    expect(
      deleteUser,
    ).not.toHaveBeenCalled();
  });

  it('rejects an incorrect current password', async () => {
    signInWithPassword.mockResolvedValue({
      data: {
        session: null,
        user: null,
      },
      error: {
        status: 400,
      },
    });

    await expect(
      service.deleteAccount(
        authUser,
        {
          currentPassword:
            'WrongPassword123!',
        },
      ),
    ).rejects.toMatchObject({
      status: 401,
    });

    expect(
      deleteUser,
    ).not.toHaveBeenCalled();
  });

  it('rate limits repeated reauthentication attempts', async () => {
    signInWithPassword.mockResolvedValue({
      data: {
        session: null,
        user: null,
      },
      error: {
        status: 429,
      },
    });

    await expect(
      service.deleteAccount(
        authUser,
        {
          currentPassword:
            'CurrentPassword123!',
        },
      ),
    ).rejects.toMatchObject({
      status: 429,
    });

    expect(
      deleteUser,
    ).not.toHaveBeenCalled();
  });

  it('rejects reauthentication that resolves to another user', async () => {
    signInWithPassword.mockResolvedValue({
      data: {
        session: {
          access_token:
            'temporary-access-token',
          refresh_token:
            'temporary-refresh-token',
        },
        user: {
          id: '22222222-2222-4222-8222-222222222222',
          email:
            'test@example.com',
        },
      },
      error: null,
    });

    await expect(
      service.deleteAccount(
        authUser,
        {
          currentPassword:
            'CurrentPassword123!',
        },
      ),
    ).rejects.toMatchObject({
      status: 401,
    });

    expect(
      deleteUser,
    ).not.toHaveBeenCalled();

    expect(
      signOut,
    ).toHaveBeenCalledWith(
      'temporary-access-token',
      'local',
    );
  });

  it('deletes the authenticated Supabase user', async () => {
    mockSuccessfulReauthentication();

    deleteUser.mockResolvedValue({
      data: {
        user: {
          id: authUser.id,
        },
      },
      error: null,
    });

    const result =
      await service.deleteAccount(
        authUser,
        {
          currentPassword:
            'CurrentPassword123!',
        },
      );

    expect(
      signInWithPassword,
    ).toHaveBeenCalledWith({
      email:
        'test@example.com',
      password:
        'CurrentPassword123!',
    });

    expect(
      deleteUser,
    ).toHaveBeenCalledWith(
      authUser.id,
    );

    expect(result).toEqual({
      status: 'deleted',
    });

    /*
     * Successful deletion removes the owner of the temporary session, so
     * no separate temporary-session logout is necessary.
     */
    expect(
      signOut,
    ).not.toHaveBeenCalled();
  });

  it('returns 409 when dependent resources block deletion', async () => {
    mockSuccessfulReauthentication();

    deleteUser.mockResolvedValue({
      data: {
        user: null,
      },
      error: {
        status: 400,
      },
    });

    await expect(
      service.deleteAccount(
        authUser,
        {
          currentPassword:
            'CurrentPassword123!',
        },
      ),
    ).rejects.toMatchObject({
      status: 409,
    });

    expect(
      signOut,
    ).toHaveBeenCalledWith(
      'temporary-access-token',
      'local',
    );
  });

  it('returns 429 when the deletion provider rate limits the request', async () => {
    mockSuccessfulReauthentication();

    deleteUser.mockResolvedValue({
      data: {
        user: null,
      },
      error: {
        status: 429,
      },
    });

    await expect(
      service.deleteAccount(
        authUser,
        {
          currentPassword:
            'CurrentPassword123!',
        },
      ),
    ).rejects.toMatchObject({
      status: 429,
    });

    expect(
      signOut,
    ).toHaveBeenCalledWith(
      'temporary-access-token',
      'local',
    );
  });

  it('returns 503 when Supabase deletion is unavailable', async () => {
    mockSuccessfulReauthentication();

    deleteUser.mockResolvedValue({
      data: {
        user: null,
      },
      error: {
        status: 500,
      },
    });

    await expect(
      service.deleteAccount(
        authUser,
        {
          currentPassword:
            'CurrentPassword123!',
        },
      ),
    ).rejects.toMatchObject({
      status: 503,
    });

    expect(
      signOut,
    ).toHaveBeenCalledWith(
      'temporary-access-token',
      'local',
    );
  });
});