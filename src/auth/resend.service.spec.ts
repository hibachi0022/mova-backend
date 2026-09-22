import { Test } from '@nestjs/testing';
import { ResendService } from './resend.service';
import { SupabaseService } from '../supabase/supabase.service';

describe('ResendService', () => {
  let service: ResendService;

  const rpc = jest.fn();
  const sendEmail = jest.fn();

  const input = {
    challengeId: 'b6f65b30-c99b-4cde-8da4-d7291e6ac817',
  };

  beforeEach(async () => {
    jest.resetAllMocks();

    const module = await Test.createTestingModule({
      providers: [
        ResendService,
        {
          provide: SupabaseService,
          useValue: {
            createAdminClient: () => ({ rpc }),
            createClient: () => ({
              auth: { resend: sendEmail },
            }),
          },
        },
      ],
    }).compile();

    service = module.get(ResendService);
  });

  it('requests a signup email and renews the challenge', async () => {
    rpc
      .mockResolvedValueOnce({
        data: { status: 'ready', email: 'test@example.com' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: true,
        error: null,
      });

    sendEmail.mockResolvedValue({ error: null });

    const result = await service.resend(input);

    expect(result.challengeId).toBe(input.challengeId);

    expect(sendEmail).toHaveBeenCalledWith({
      type: 'signup',
      email: 'test@example.com',
    });

    expect(rpc).toHaveBeenNthCalledWith(
      2,
      'finish_signup_resend',
      { p_challenge_id: input.challengeId },
    );
  });

  it('blocks email sending during the cooldown', async () => {
    rpc.mockResolvedValue({
      data: { status: 'cooldown' },
      error: null,
    });

    await expect(service.resend(input)).rejects.toMatchObject({
      status: 429,
    });

    expect(sendEmail).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('rejects an unavailable challenge without sending email', async () => {
    rpc.mockResolvedValue({
      data: { status: 'invalid' },
      error: null,
    });

    await expect(service.resend(input)).rejects.toMatchObject({
      status: 400,
    });

    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('does not send email when the database is unavailable', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: 'Database unavailable' },
    });

    await expect(service.resend(input)).rejects.toMatchObject({
      status: 503,
    });

    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('preserves provider rate-limit errors without renewing', async () => {
    rpc.mockResolvedValue({
      data: { status: 'ready', email: 'test@example.com' },
      error: null,
    });

    sendEmail.mockResolvedValue({
      error: { status: 429 },
    });

    await expect(service.resend(input)).rejects.toMatchObject({
      status: 429,
    });

    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('does not renew the challenge after failed email delivery', async () => {
    rpc.mockResolvedValue({
      data: { status: 'ready', email: 'test@example.com' },
      error: null,
    });

    sendEmail.mockRejectedValue(new Error('Connection failed'));

    await expect(service.resend(input)).rejects.toMatchObject({
      status: 503,
    });

    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('does not report success when challenge renewal fails', async () => {
    rpc
      .mockResolvedValueOnce({
        data: { status: 'ready', email: 'test@example.com' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: null,
        error: { message: 'Database unavailable' },
      });

    sendEmail.mockResolvedValue({ error: null });

    await expect(service.resend(input)).rejects.toMatchObject({
      status: 503,
    });
  });

  it('rejects a challenge consumed while the email was being sent', async () => {
    rpc
      .mockResolvedValueOnce({
        data: { status: 'ready', email: 'test@example.com' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: false,
        error: null,
      });

    sendEmail.mockResolvedValue({ error: null });

    await expect(service.resend(input)).rejects.toMatchObject({
      status: 400,
    });
  });
});