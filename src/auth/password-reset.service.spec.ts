import { Test } from '@nestjs/testing';
import { SupabaseService } from '../supabase/supabase.service';
import { PasswordResetService } from './password-reset.service';

describe('PasswordResetService', () => {
  let service: PasswordResetService;

  const rpc = jest.fn();
  const resetPasswordForEmail = jest.fn();
  const verifyOtp = jest.fn();
  const updateUserById = jest.fn();
  const signOut = jest.fn();

  const requestInput = {
    email: 'test@example.com',
  };

  const confirmInput = {
    email: 'test@example.com',
    code: '123456',
    newPassword: 'NewPassword123!',
  };

  beforeEach(async () => {
    jest.resetAllMocks();

    const module = await Test.createTestingModule({
      providers: [
        PasswordResetService,
        {
          provide: SupabaseService,
          useValue: {
            createAdminClient: () => ({
              rpc,
              auth: {
                admin: {
                  updateUserById,
                  signOut,
                },
              },
            }),
            createClient: () => ({
              auth: {
                resetPasswordForEmail,
                verifyOtp,
              },
            }),
          },
        },
      ],
    }).compile();

    service = module.get(PasswordResetService);
  });

  it('requests a recovery email and returns a generic response', async () => {
    rpc.mockResolvedValue({
      data: {
        status: 'ready',
        challengeId: 'b6f65b30-c99b-4cde-8da4-d7291e6ac817',
        email: 'test@example.com',
      },
      error: null,
    });

    resetPasswordForEmail.mockResolvedValue({
      data: {},
      error: null,
    });

    const result = await service.request(requestInput);

    expect(result).toEqual({
      message:
        'If an account matches this email, a reset code has been requested.',
    });

    expect(rpc).toHaveBeenCalledWith(
      'reserve_password_reset_request',
      {
        p_email: 'test@example.com',
      },
    );

    expect(resetPasswordForEmail).toHaveBeenCalledWith(
      'test@example.com',
    );
  });

  it('blocks reset email sending during the database cooldown', async () => {
    rpc.mockResolvedValue({
      data: {
        status: 'cooldown',
      },
      error: null,
    });

    await expect(
      service.request(requestInput),
    ).rejects.toMatchObject({
      status: 429,
    });

    expect(resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it('rejects an exhausted reset request without sending email', async () => {
    rpc.mockResolvedValue({
      data: {
        status: 'invalid',
      },
      error: null,
    });

    await expect(
      service.request(requestInput),
    ).rejects.toMatchObject({
      status: 400,
    });

    expect(resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it('preserves provider password-reset rate limiting', async () => {
    rpc.mockResolvedValue({
      data: {
        status: 'ready',
        challengeId: 'b6f65b30-c99b-4cde-8da4-d7291e6ac817',
        email: 'test@example.com',
      },
      error: null,
    });

    resetPasswordForEmail.mockResolvedValue({
      data: null,
      error: {
        status: 429,
      },
    });

    await expect(
      service.request(requestInput),
    ).rejects.toMatchObject({
      status: 429,
    });
  });

  it('verifies a recovery OTP, updates the password and revokes sessions', async () => {
    const challengeId =
      'b6f65b30-c99b-4cde-8da4-d7291e6ac817';

    rpc
      .mockResolvedValueOnce({
        data: {
          status: 'ready',
          challengeId,
          email: 'test@example.com',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: true,
        error: null,
      });

    verifyOtp.mockResolvedValue({
      data: {
        session: {
          access_token: 'recovery-access-token',
          refresh_token: 'recovery-refresh-token',
        },
        user: {
          id: '11111111-1111-4111-8111-111111111111',
          email: 'test@example.com',
        },
      },
      error: null,
    });

    updateUserById.mockResolvedValue({
      data: {
        user: {
          id: '11111111-1111-4111-8111-111111111111',
        },
      },
      error: null,
    });

    signOut.mockResolvedValue({
      error: null,
    });

    const result = await service.confirm(confirmInput);

    expect(verifyOtp).toHaveBeenCalledWith({
      email: 'test@example.com',
      token: '123456',
      type: 'recovery',
    });

    expect(rpc).toHaveBeenNthCalledWith(
      2,
      'complete_password_reset_challenge',
      {
        p_challenge_id: challengeId,
      },
    );

    expect(updateUserById).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      {
        password: 'NewPassword123!',
      },
    );

    expect(signOut).toHaveBeenCalledWith(
      'recovery-access-token',
      'global',
    );

    expect(result).toEqual({
      message:
        'Password updated. Sign in again with your new password.',
    });
  });

  it('rejects an invalid recovery code without changing the password', async () => {
    rpc.mockResolvedValueOnce({
      data: {
        status: 'ready',
        challengeId: 'b6f65b30-c99b-4cde-8da4-d7291e6ac817',
        email: 'test@example.com',
      },
      error: null,
    });

    verifyOtp.mockResolvedValue({
      data: {
        session: null,
        user: null,
      },
      error: {
        status: 403,
      },
    });

    await expect(
      service.confirm(confirmInput),
    ).rejects.toMatchObject({
      status: 400,
    });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it('rejects an unavailable application reset challenge before verifying the OTP', async () => {
    rpc.mockResolvedValue({
      data: {
        status: 'invalid',
      },
      error: null,
    });

    await expect(
      service.confirm(confirmInput),
    ).rejects.toMatchObject({
      status: 400,
    });

    expect(verifyOtp).not.toHaveBeenCalled();
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it('revokes the recovery session when database completion fails', async () => {
    rpc
      .mockResolvedValueOnce({
        data: {
          status: 'ready',
          challengeId:
            'b6f65b30-c99b-4cde-8da4-d7291e6ac817',
          email: 'test@example.com',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: null,
        error: {
          message: 'Database unavailable',
        },
      });

    verifyOtp.mockResolvedValue({
      data: {
        session: {
          access_token: 'recovery-access-token',
          refresh_token: 'recovery-refresh-token',
        },
        user: {
          id: '11111111-1111-4111-8111-111111111111',
          email: 'test@example.com',
        },
      },
      error: null,
    });

    signOut.mockResolvedValue({
      error: null,
    });

    await expect(
      service.confirm(confirmInput),
    ).rejects.toMatchObject({
      status: 503,
    });

    expect(signOut).toHaveBeenCalledWith(
      'recovery-access-token',
      'local',
    );

    expect(updateUserById).not.toHaveBeenCalled();
  });

  it('requires a new reset code when the new password is rejected', async () => {
    rpc
      .mockResolvedValueOnce({
        data: {
          status: 'ready',
          challengeId:
            'b6f65b30-c99b-4cde-8da4-d7291e6ac817',
          email: 'test@example.com',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: true,
        error: null,
      });

    verifyOtp.mockResolvedValue({
      data: {
        session: {
          access_token: 'recovery-access-token',
          refresh_token: 'recovery-refresh-token',
        },
        user: {
          id: '11111111-1111-4111-8111-111111111111',
          email: 'test@example.com',
        },
      },
      error: null,
    });

    updateUserById.mockResolvedValue({
      data: {
        user: null,
      },
      error: {
        status: 422,
        code: 'weak_password',
      },
    });

    signOut.mockResolvedValue({
      error: null,
    });

    await expect(
      service.confirm(confirmInput),
    ).rejects.toMatchObject({
      status: 422,
    });

    expect(signOut).toHaveBeenCalledWith(
      'recovery-access-token',
      'local',
    );
  });
});