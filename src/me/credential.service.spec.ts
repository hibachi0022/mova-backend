import { Test } from '@nestjs/testing';
import type { User } from '@supabase/supabase-js';
import { SupabaseService } from '../supabase/supabase.service';
import { CredentialService } from './credential.service';

describe('CredentialService', () => {
  let service: CredentialService;

  const signInWithPassword =
    jest.fn();
  const updateUser =
    jest.fn();
  const signOut =
    jest.fn();

  const authUser = {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'current@example.com',
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
          CredentialService,
          {
            provide:
              SupabaseService,
            useValue: {
              createClient:
                () => ({
                  auth: {
                    signInWithPassword,
                    updateUser,
                  },
                }),
              createAdminClient:
                () => ({
                  auth: {
                    admin: {
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
        CredentialService,
      );
  });

  function mockSuccessfulSignIn() {
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
            'current@example.com',
        },
      },
      error: null,
    });
  }

  it('rejects a request with no actual changes', async () => {
    await expect(
      service.change(
        authUser,
        {
          email:
            'current@example.com',
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
      service.change(
        authUser,
        {
          email:
            'new@example.com',
          currentPassword:
            'WrongPassword123!',
        },
      ),
    ).rejects.toMatchObject({
      status: 401,
    });

    expect(
      updateUser,
    ).not.toHaveBeenCalled();
  });

  it('requests an email change through the authenticated user flow', async () => {
    mockSuccessfulSignIn();

    updateUser.mockResolvedValue({
      data: {
        user: {
          id: authUser.id,
          email:
            'current@example.com',
        },
      },
      error: null,
    });

    const result =
      await service.change(
        authUser,
        {
          email:
            'new@example.com',
          currentPassword:
            'CurrentPassword123!',
        },
      );

    expect(
      signInWithPassword,
    ).toHaveBeenCalledWith({
      email:
        'current@example.com',
      password:
        'CurrentPassword123!',
    });

    expect(
      updateUser,
    ).toHaveBeenCalledWith({
      email:
        'new@example.com',
    });

    expect(
      signOut,
    ).toHaveBeenCalledWith(
      'temporary-access-token',
      'local',
    );

    expect(result).toEqual({
      status:
        'confirmation_required',
    });
  });

  it('changes a password using the supplied current password', async () => {
    mockSuccessfulSignIn();

    updateUser.mockResolvedValue({
      data: {
        user: {
          id: authUser.id,
          email:
            'current@example.com',
        },
      },
      error: null,
    });

    const result =
      await service.change(
        authUser,
        {
          email:
            'current@example.com',
          currentPassword:
            'CurrentPassword123!',
          newPassword:
            'NewPassword123!',
        },
      );

    expect(
      updateUser,
    ).toHaveBeenCalledWith({
      password:
        'NewPassword123!',
      current_password:
        'CurrentPassword123!',
    });

    expect(
      signOut,
    ).toHaveBeenCalledWith(
      'temporary-access-token',
      'global',
    );

    expect(result).toEqual({
      status:
        'password_updated',
    });
  });

  it('supports a combined email and password change', async () => {
    mockSuccessfulSignIn();

    updateUser.mockResolvedValue({
      data: {
        user: {
          id: authUser.id,
          email:
            'current@example.com',
        },
      },
      error: null,
    });

    const result =
      await service.change(
        authUser,
        {
          email:
            'new@example.com',
          currentPassword:
            'CurrentPassword123!',
          newPassword:
            'NewPassword123!',
        },
      );

    expect(
      updateUser,
    ).toHaveBeenCalledWith({
      email:
        'new@example.com',
      password:
        'NewPassword123!',
      current_password:
        'CurrentPassword123!',
    });

    expect(
      signOut,
    ).toHaveBeenCalledWith(
      'temporary-access-token',
      'global',
    );

    expect(result).toEqual({
      status:
        'confirmation_required',
      passwordUpdated: true,
    });
  });

  it('does not allow the new password to equal the current password', async () => {
    await expect(
      service.change(
        authUser,
        {
          email:
            'current@example.com',
          currentPassword:
            'SamePassword123!',
          newPassword:
            'SamePassword123!',
        },
      ),
    ).rejects.toMatchObject({
      status: 400,
    });

    expect(
      signInWithPassword,
    ).not.toHaveBeenCalled();
  });

  it('rejects a credential update that resolves to another user', async () => {
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
            'current@example.com',
        },
      },
      error: null,
    });

    await expect(
      service.change(
        authUser,
        {
          email:
            'new@example.com',
          currentPassword:
            'CurrentPassword123!',
        },
      ),
    ).rejects.toMatchObject({
      status: 401,
    });

    expect(
      updateUser,
    ).not.toHaveBeenCalled();

    expect(
      signOut,
    ).toHaveBeenCalledWith(
      'temporary-access-token',
      'local',
    );
  });

  it('maps provider weak-password errors to 422', async () => {
    mockSuccessfulSignIn();

    updateUser.mockResolvedValue({
      data: {
        user: null,
      },
      error: {
        status: 422,
        code: 'weak_password',
      },
    });

    await expect(
      service.change(
        authUser,
        {
          email:
            'current@example.com',
          currentPassword:
            'CurrentPassword123!',
          newPassword:
            'AnotherPassword123!',
        },
      ),
    ).rejects.toMatchObject({
      status: 422,
    });
  });
});