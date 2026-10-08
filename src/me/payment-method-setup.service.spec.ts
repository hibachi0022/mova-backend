import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { SupabaseService } from '../supabase/supabase.service';
import { PaymentMethodSetupService } from './payment-method-setup.service';

describe(
  'PaymentMethodSetupService',
  () => {
    let service:
      PaymentMethodSetupService;

    const userId =
      '11111111-1111-4111-8111-111111111111';

    const setupId =
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    const email =
      'samuel@example.com';

    const idempotencyKey =
      'card-setup-key-12345';

    const checkoutUrl =
      'https://checkout.paystack.com/example';

    const accessCode =
      'access-example';

    const reference =
      'MOVA-CARD-aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa';

    const rpc =
      jest.fn();

    const originalFetch =
      global.fetch;

    beforeEach(
      async () => {
        jest.resetAllMocks();

        global.fetch =
          jest.fn(
            async () =>
              ({
                ok:
                  true,

                status:
                  200,

                json:
                  async () => ({
                    status:
                      true,

                    data: {
                      authorization_url:
                        checkoutUrl,

                      access_code:
                        accessCode,

                      reference,
                    },
                  }),
              }) as
                unknown as
                Response,
          );

        const module =
          await Test.createTestingModule({
            providers: [
              PaymentMethodSetupService,

              {
                provide:
                  ConfigService,

                useValue: {
                  get:
                    jest.fn(
                      (
                        key:
                          string,
                      ) =>
                        key ===
                        'PAYSTACK_SECRET_KEY'
                          ? 'sk_test_example'
                          : undefined,
                    ),
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
            PaymentMethodSetupService,
          );
      },
    );

    afterAll(
      () => {
        global.fetch =
          originalFetch;
      },
    );

    it('creates a fixed NGN 50 card-only Paystack checkout', async () => {
      rpc.mockImplementation(
        async (
          name:
            string,
        ) => {
          if (
            name ===
            'prepare_payment_method_setup'
          ) {
            return {
              data: {
                status:
                  'created',

                setupId,

                setupStatus:
                  'created',

                amountMinor:
                  5000,

                currency:
                  'NGN',

                expiresAt:
                  new Date(
                    Date.now() +
                      10 * 60_000,
                  ).toISOString(),
              },

              error:
                null,
            };
          }

          if (
            name ===
            'bind_payment_method_setup_checkout'
          ) {
            return {
              data: {
                status:
                  'ready',

                setupId,

                checkoutUrl,

                providerReference:
                  reference,
              },

              error:
                null,
            };
          }

          throw new Error(
            `Unexpected RPC ${name}`,
          );
        },
      );

      await expect(
        service.create(
          userId,
          email,
          idempotencyKey,
        ),
      ).resolves.toEqual({
        checkoutUrl,
      });

      expect(
        global.fetch,
      ).toHaveBeenCalledTimes(
        1,
      );

      const fetchMock =
        global.fetch as
          jest.Mock;

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
        'https://api.paystack.co/transaction/initialize',
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
        ) as {
          email: string;
          amount: string;
          currency: string;
          reference: string;
          channels: string[];
          metadata: string;
        };

      expect(
        body.email,
      ).toBe(
        email,
      );

      expect(
        body.amount,
      ).toBe(
        '5000',
      );

      expect(
        body.currency,
      ).toBe(
        'NGN',
      );

      expect(
        body.channels,
      ).toEqual([
        'card',
      ]);

      expect(
        body.reference,
      ).toBe(
        reference,
      );

      expect(
        JSON.parse(
          body.metadata,
        ),
      ).toEqual({
        purpose:
          'payment_method_setup',

        movaPaymentMethodSetupId:
          setupId,
      });

      expect(
        rpc,
      ).toHaveBeenCalledWith(
        'bind_payment_method_setup_checkout',
        {
          p_user_id:
            userId,

          p_setup_id:
            setupId,

          p_provider_reference:
            reference,

          p_provider_checkout_id:
            accessCode,

          p_provider_checkout_url:
            checkoutUrl,
        },
      );
    });

    it('reuses an existing checkout for the same idempotency key', async () => {
      rpc.mockResolvedValue({
        data: {
          status:
            'existing',

          setupId,

          setupStatus:
            'checkout_ready',

          amountMinor:
            5000,

          currency:
            'NGN',

          checkoutUrl,

          expiresAt:
            new Date(
              Date.now() +
                10 * 60_000,
            ).toISOString(),
        },

        error:
          null,
      });

      await expect(
        service.create(
          userId,
          email,
          idempotencyKey,
        ),
      ).resolves.toEqual({
        checkoutUrl,
      });

      expect(
        global.fetch,
      ).not.toHaveBeenCalled();
    });

    it('resumes an existing setup that was prepared but not initialized', async () => {
      rpc.mockImplementation(
        async (
          name:
            string,
        ) => {
          if (
            name ===
            'prepare_payment_method_setup'
          ) {
            return {
              data: {
                status:
                  'existing',

                setupId,

                setupStatus:
                  'created',

                amountMinor:
                  5000,

                currency:
                  'NGN',

                expiresAt:
                  new Date(
                    Date.now() +
                      10 * 60_000,
                  ).toISOString(),
              },

              error:
                null,
            };
          }

          if (
            name ===
            'bind_payment_method_setup_checkout'
          ) {
            return {
              data: {
                status:
                  'ready',

                checkoutUrl,

                providerReference:
                  reference,
              },

              error:
                null,
            };
          }

          throw new Error(
            `Unexpected RPC ${name}`,
          );
        },
      );

      await expect(
        service.create(
          userId,
          email,
          idempotencyKey,
        ),
      ).resolves.toEqual({
        checkoutUrl,
      });

      expect(
        global.fetch,
      ).toHaveBeenCalledTimes(
        1,
      );
    });

    it('reuses a different still-active setup checkout instead of creating another', async () => {
      rpc.mockResolvedValue({
        data: {
          status:
            'setup_in_progress',

          setupId,

          setupStatus:
            'checkout_ready',

          amountMinor:
            5000,

          currency:
            'NGN',

          checkoutUrl,

          expiresAt:
            new Date(
              Date.now() +
                10 * 60_000,
            ).toISOString(),
        },

        error:
          null,
      });

      await expect(
        service.create(
          userId,
          email,
          idempotencyKey,
        ),
      ).resolves.toEqual({
        checkoutUrl,
      });

      expect(
        global.fetch,
      ).not.toHaveBeenCalled();
    });

    it('rejects another request while a setup is still being prepared', async () => {
      rpc.mockResolvedValue({
        data: {
          status:
            'setup_in_progress',

          setupId,

          setupStatus:
            'created',

          amountMinor:
            5000,

          currency:
            'NGN',

          expiresAt:
            new Date(
              Date.now() +
                10 * 60_000,
            ).toISOString(),
        },

        error:
          null,
      });

      await expect(
        service.create(
          userId,
          email,
          idempotencyKey,
        ),
      ).rejects.toMatchObject({
        status:
          409,

        message:
          'A card setup is already being prepared. Try again shortly.',
      });

      expect(
        global.fetch,
      ).not.toHaveBeenCalled();
    });

    it('rejects an invalid idempotency key before touching the database', async () => {
      await expect(
        service.create(
          userId,
          email,
          'short',
        ),
      ).rejects.toMatchObject({
        status:
          400,

        message:
          'A valid Idempotency-Key header is required.',
      });

      expect(
        rpc,
      ).not.toHaveBeenCalled();

      expect(
        global.fetch,
      ).not.toHaveBeenCalled();
    });

    it('requires a valid authenticated account email', async () => {
      await expect(
        service.create(
          userId,
          undefined,
          idempotencyKey,
        ),
      ).rejects.toMatchObject({
        status:
          422,

        message:
          'A valid account email is required to add a payment method.',
      });

      expect(
        rpc,
      ).not.toHaveBeenCalled();

      expect(
        global.fetch,
      ).not.toHaveBeenCalled();
    });

    it('rejects corrupted trusted amount data before contacting Paystack', async () => {
      rpc.mockResolvedValue({
        data: {
          status:
            'created',

          setupId,

          setupStatus:
            'created',

          amountMinor:
            100000,

          currency:
            'NGN',

          expiresAt:
            new Date(
              Date.now() +
                10 * 60_000,
            ).toISOString(),
        },

        error:
          null,
      });

      await expect(
        service.create(
          userId,
          email,
          idempotencyKey,
        ),
      ).rejects.toMatchObject({
        status:
          503,

        message:
          'The card setup request could not be loaded safely.',
      });

      expect(
        global.fetch,
      ).not.toHaveBeenCalled();
    });

    it('fails the local setup when Paystack initialization definitively fails', async () => {
      rpc.mockImplementation(
        async (
          name:
            string,
        ) => {
          if (
            name ===
            'prepare_payment_method_setup'
          ) {
            return {
              data: {
                status:
                  'created',

                setupId,

                setupStatus:
                  'created',

                amountMinor:
                  5000,

                currency:
                  'NGN',

                expiresAt:
                  new Date(
                    Date.now() +
                      10 * 60_000,
                  ).toISOString(),
              },

              error:
                null,
            };
          }

          if (
            name ===
            'fail_payment_method_setup'
          ) {
            return {
              data: {
                status:
                  'failed',

                setupId,
              },

              error:
                null,
            };
          }

          throw new Error(
            `Unexpected RPC ${name}`,
          );
        },
      );

      global.fetch =
        jest.fn(
          async () =>
            ({
              ok:
                false,

              status:
                400,

              json:
                async () => ({
                  status:
                    false,

                  message:
                    'Unable to initialize transaction',
                }),
            }) as
              unknown as
              Response,
        );

      await expect(
        service.create(
          userId,
          email,
          idempotencyKey,
        ),
      ).rejects.toMatchObject({
        status:
          503,

        message:
          'Secure card setup is temporarily unavailable.',
      });

      expect(
        rpc,
      ).toHaveBeenCalledWith(
        'fail_payment_method_setup',
        {
          p_user_id:
            userId,

          p_setup_id:
            setupId,
        },
      );
    });
  },
);