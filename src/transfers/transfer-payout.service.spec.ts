import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { SupabaseService } from '../supabase/supabase.service';
import { TransferPayoutService } from './transfer-payout.service';

describe(
  'TransferPayoutService',
  () => {
    let service:
      TransferPayoutService;

    const payoutId =
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    const providerReference =
      'mova-po-aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa';

    const recipientCode =
      'RCP_testrecipient';

    const rpc =
      jest.fn();

    const fetchMock =
      jest.fn();

    const originalFetch =
      globalThis.fetch;

    function response(
      status:
        number,

      value:
        unknown,
    ): Response {
      return {
        ok:
          status >=
            200 &&
          status <
            300,

        status,

        text:
          async () =>
            JSON.stringify(
              value,
            ),
      } as
        unknown as
        Response;
    }

    function beginReady() {
      return {
        data: {
          status:
            'ready',

          payoutId,

          amountMinor:
            250000,

          currency:
            'NGN',

          providerReference,

          providerRecipientCode:
            recipientCode,
        },

        error:
          null,
      };
    }

    function beginExisting() {
      return {
        data: {
          status:
            'existing',

          payoutId,

          amountMinor:
            250000,

          currency:
            'NGN',

          providerReference,

          providerRecipientCode:
            recipientCode,
        },

        error:
          null,
      };
    }

    function providerTransfer(
      status:
        string =
          'pending',

      overrides: {
        reference?:
          string;

        amount?:
          number;

        currency?:
          string;

        transferCode?:
          string;

        id?:
          number | string;
      } = {},
    ) {
      return response(
        200,
        {
          status:
            true,

          data: {
            reference:
              overrides.reference ??
              providerReference,

            amount:
              overrides.amount ??
              250000,

            currency:
              overrides.currency ??
              'NGN',

            status,

            transfer_code:
              overrides.transferCode ??
              'TRF_testtransfer',

            id:
              overrides.id ??
              123456,
          },
        },
      );
    }

    beforeEach(
      async () => {
        jest.resetAllMocks();

        globalThis.fetch =
          fetchMock as
            unknown as
            typeof fetch;

        const module =
          await Test.createTestingModule({
            providers: [
              TransferPayoutService,

              {
                provide:
                  ConfigService,

                useValue: {
                  get:
                    (
                      key:
                        string,
                    ) =>
                      key ===
                      'PAYSTACK_SECRET_KEY'
                        ? 'sk_test_transfer_payout'
                        : undefined,
                },
              },

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
          }).compile();

        service =
          module.get(
            TransferPayoutService,
          );
      },
    );

    afterAll(
      () => {
        globalThis.fetch =
          originalFetch;
      },
    );

    it('initiates a Paystack payout and records the provider transfer', async () => {
      rpc
        .mockResolvedValueOnce(
          beginReady(),
        )
        .mockResolvedValueOnce({
          data: {
            status:
              'recorded',

            payoutId,

            payoutStatus:
              'pending',

            providerStatus:
              'pending',
          },

          error:
            null,
        });

      fetchMock.mockResolvedValueOnce(
        providerTransfer(
          'pending',
        ),
      );

      await expect(
        service.initiate(
          payoutId,
        ),
      ).resolves.toEqual({
        status:
          'processing',
      });

      expect(
        rpc,
      ).toHaveBeenNthCalledWith(
        1,
        'begin_friend_transfer_payout',
        {
          p_payout_id:
            payoutId,

          p_provider_reference:
            providerReference,
        },
      );

      const [
        url,
        options,
      ] =
        fetchMock.mock
          .calls[0] as [
          string,
          RequestInit,
        ];

      expect(
        url,
      ).toBe(
        'https://api.paystack.co/transfer',
      );

      expect(
        options.method,
      ).toBe(
        'POST',
      );

      const body =
        JSON.parse(
          options.body as
            string,
        ) as
          Record<
            string,
            unknown
          >;

      expect(
        body,
      ).toEqual({
        source:
          'balance',

        amount:
          250000,

        recipient:
          recipientCode,

        reference:
          providerReference,

        reason:
          'MOVA friend transfer',

        currency:
          'NGN',
      });

      expect(
        rpc,
      ).toHaveBeenNthCalledWith(
        2,
        'record_friend_transfer_payout_initiation',
        {
          p_payout_id:
            payoutId,

          p_provider_reference:
            providerReference,

          p_provider_transfer_code:
            'TRF_testtransfer',

          p_provider_transfer_id:
            '123456',

          p_provider_status:
            'pending',
        },
      );
    });

    it('does not treat an immediate Paystack success response as final payout completion', async () => {
      rpc
        .mockResolvedValueOnce(
          beginReady(),
        )
        .mockResolvedValueOnce({
          data: {
            status:
              'recorded',

            payoutId,

            payoutStatus:
              'pending',

            providerStatus:
              'success',
          },

          error:
            null,
        });

      fetchMock.mockResolvedValueOnce(
        providerTransfer(
          'success',
        ),
      );

      await expect(
        service.initiate(
          payoutId,
        ),
      ).resolves.toEqual({
        status:
          'processing',
      });
    });

    it('surfaces Paystack OTP requirement without marking the payout complete', async () => {
      rpc
        .mockResolvedValueOnce(
          beginReady(),
        )
        .mockResolvedValueOnce({
          data: {
            status:
              'recorded',

            payoutId,

            payoutStatus:
              'otp_required',

            providerStatus:
              'otp',
          },

          error:
            null,
        });

      fetchMock.mockResolvedValueOnce(
        providerTransfer(
          'otp',
        ),
      );

      await expect(
        service.initiate(
          payoutId,
        ),
      ).resolves.toEqual({
        status:
          'otp_required',
      });
    });

    it('recovers an existing initiating payout using Paystack Verify Transfer instead of creating another transfer', async () => {
      rpc
        .mockResolvedValueOnce(
          beginExisting(),
        )
        .mockResolvedValueOnce({
          data: {
            status:
              'recorded',

            payoutId,

            payoutStatus:
              'pending',

            providerStatus:
              'pending',
          },

          error:
            null,
        });

      fetchMock.mockResolvedValueOnce(
        providerTransfer(
          'pending',
        ),
      );

      await expect(
        service.initiate(
          payoutId,
        ),
      ).resolves.toEqual({
        status:
          'processing',
      });

      expect(
        fetchMock,
      ).toHaveBeenCalledTimes(
        1,
      );

      expect(
        fetchMock.mock
          .calls[0][0],
      ).toBe(
        `https://api.paystack.co/transfer/verify/${providerReference}`,
      );

      expect(
        (
          fetchMock.mock
            .calls[0][1] as
            RequestInit
        ).method,
      ).toBe(
        'GET',
      );
    });

    it('does not resubmit an existing payout when Paystack verification is unavailable', async () => {
      rpc.mockResolvedValueOnce(
        beginExisting(),
      );

      fetchMock.mockResolvedValueOnce(
        response(
          404,
          {
            status:
              false,

            message:
              'Transfer not found',
          },
        ),
      );

      await expect(
        service.initiate(
          payoutId,
        ),
      ).resolves.toEqual({
        status:
          'verification_pending',
      });

      expect(
        fetchMock,
      ).toHaveBeenCalledTimes(
        1,
      );

      expect(
        (
          fetchMock.mock
            .calls[0][1] as
            RequestInit
        ).method,
      ).toBe(
        'GET',
      );

      expect(
        rpc,
      ).toHaveBeenCalledTimes(
        1,
      );
    });

    it('returns completed when the payout has already been finalized', async () => {
      rpc.mockResolvedValueOnce({
        data: {
          status:
            'already_completed',

          payoutId,
        },

        error:
          null,
      });

      await expect(
        service.initiate(
          payoutId,
        ),
      ).resolves.toEqual({
        status:
          'completed',
      });

      expect(
        fetchMock,
      ).not.toHaveBeenCalled();
    });

    it('rejects a missing payout before contacting Paystack', async () => {
      rpc.mockResolvedValueOnce({
        data: {
          status:
            'not_found',
        },

        error:
          null,
      });

      await expect(
        service.initiate(
          payoutId,
        ),
      ).rejects.toMatchObject({
        status:
          404,

        message:
          'Transfer payout not found.',
      });

      expect(
        fetchMock,
      ).not.toHaveBeenCalled();
    });

    it('rejects a provider response with an unexpected payout reference', async () => {
      rpc.mockResolvedValueOnce(
        beginReady(),
      );

      fetchMock.mockResolvedValueOnce(
        providerTransfer(
          'pending',
          {
            reference:
              'mova-po-bbbbbbbbbbbb4bbb8bbbbbbbbbbbbbbb',
          },
        ),
      );

      await expect(
        service.initiate(
          payoutId,
        ),
      ).rejects.toMatchObject({
        status:
          503,

        message:
          'Paystack returned an unexpected payout reference.',
      });

      expect(
        rpc,
      ).toHaveBeenCalledTimes(
        1,
      );
    });

    it('keeps the payout processing when the Paystack initiation response is uncertain', async () => {
      rpc.mockResolvedValueOnce(
        beginReady(),
      );

      fetchMock.mockRejectedValueOnce(
        new Error(
          'network disconnected',
        ),
      );

      await expect(
        service.initiate(
          payoutId,
        ),
      ).resolves.toEqual({
        status:
          'verification_pending',
      });

      expect(
        rpc,
      ).toHaveBeenCalledTimes(
        1,
      );
    });

    it('fails safely when Paystack accepted the transfer but MOVA cannot persist its provider identifiers', async () => {
      rpc
        .mockResolvedValueOnce(
          beginReady(),
        )
        .mockResolvedValueOnce({
          data:
            null,

          error: {
            message:
              'database unavailable',
          },
        });

      fetchMock.mockResolvedValueOnce(
        providerTransfer(
          'pending',
        ),
      );

      await expect(
        service.initiate(
          payoutId,
        ),
      ).rejects.toMatchObject({
        status:
          503,

        message:
          'The payout was submitted but MOVA could not record the provider transfer safely.',
      });
    });
  },
);