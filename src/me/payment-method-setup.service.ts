import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { SupabaseService } from '../supabase/supabase.service';

type PrepareSetupResult = {
  status?: string;

  setupId?: string;

  setupStatus?: string;

  amountMinor?:
    | number
    | string;

  currency?: string;

  providerReference?:
    | string
    | null;

  checkoutUrl?:
    | string
    | null;

  expiresAt?: string;
};

type BindSetupResult = {
  status?: string;

  setupId?: string;

  checkoutUrl?: string;

  providerReference?: string;

  expiresAt?: string;

  setupStatus?: string;
};

type PaystackInitializeResponse = {
  status?: boolean;

  message?: string;

  data?: {
    authorization_url?: string;

    access_code?: string;

    reference?: string;
  };
};

type TrustedSetup = {
  setupId: string;

  amountMinor: number;

  currency: 'NGN';

  expiresAt: string;
};

@Injectable()
export class PaymentMethodSetupService {
  private readonly secretKey:
    string;

  constructor(
    private readonly config:
      ConfigService,

    private readonly supabase:
      SupabaseService,
  ) {
    this.secretKey =
      this.config
        .get<string>(
          'PAYSTACK_SECRET_KEY',
        )
        ?.trim() ??
      '';
  }

  async create(
    userId: string,

    email:
      | string
      | undefined,

    idempotencyKey:
      | string
      | undefined,
  ): Promise<{
    checkoutUrl: string;
  }> {
    const cleanKey =
      this.validateIdempotencyKey(
        idempotencyKey,
      );

    const cleanEmail =
      email
        ?.trim()
        .toLowerCase() ??
      '';

    if (
      !this.isReasonableEmail(
        cleanEmail,
      )
    ) {
      throw new UnprocessableEntityException(
        'A valid account email is required to add a payment method.',
      );
    }

    if (
      !this.isConfigured()
    ) {
      throw new ServiceUnavailableException(
        'Secure card setup is not connected right now.',
      );
    }

    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } =
      await admin.rpc(
        'prepare_payment_method_setup',
        {
          p_user_id:
            userId,

          p_email:
            cleanEmail,

          p_idempotency_key_hash:
            this.hashIdempotencyKey(
              cleanKey,
            ),
        },
      );

    if (
      error ||
      !data
    ) {
      throw new ServiceUnavailableException(
        'Unable to prepare card setup right now.',
      );
    }

    const result =
      data as
        PrepareSetupResult;

    switch (
      result.status
    ) {
      case 'created':
        return this.initializeAndBind(
          userId,
          cleanEmail,
          result,
        );

      case 'existing':
        return this.handleExisting(
          userId,
          cleanEmail,
          result,
        );

      case 'setup_in_progress':
        return this.handleOpenSetup(
          result,
        );

      case 'invalid':
        throw new BadRequestException(
          'Unable to prepare this card setup request.',
        );

      case 'not_found':
        throw new ServiceUnavailableException(
          'Your account is not ready for card setup right now.',
        );

      default:
        throw new ServiceUnavailableException(
          'Unable to prepare card setup right now.',
        );
    }
  }

  private async handleExisting(
    userId: string,

    email: string,

    result:
      PrepareSetupResult,
  ): Promise<{
    checkoutUrl: string;
  }> {
    if (
      result.setupStatus ===
        'checkout_ready'
    ) {
      if (
        typeof result.checkoutUrl !==
        'string'
      ) {
        throw new ServiceUnavailableException(
          'The saved card setup could not be loaded safely.',
        );
      }

      return {
        checkoutUrl:
          this.validateCheckoutUrl(
            result.checkoutUrl,
          ),
      };
    }

    if (
      result.setupStatus ===
        'created'
    ) {
      return this.initializeAndBind(
        userId,
        email,
        result,
      );
    }

    if (
      result.setupStatus ===
        'completed'
    ) {
      throw new ConflictException(
        'This card setup has already been completed.',
      );
    }

    if (
      result.setupStatus ===
        'failed' ||
      result.setupStatus ===
        'expired'
    ) {
      throw new ConflictException(
        'This card setup attempt is no longer active. Start again.',
      );
    }

    throw new ConflictException(
      'This card setup attempt is no longer available.',
    );
  }

  private handleOpenSetup(
    result:
      PrepareSetupResult,
  ): {
    checkoutUrl: string;
  } {
    if (
      result.setupStatus ===
        'checkout_ready' &&
      typeof result.checkoutUrl ===
        'string'
    ) {
      return {
        checkoutUrl:
          this.validateCheckoutUrl(
            result.checkoutUrl,
          ),
      };
    }

    throw new ConflictException(
      'A card setup is already being prepared. Try again shortly.',
    );
  }

  private async initializeAndBind(
    userId: string,

    email: string,

    result:
      PrepareSetupResult,
  ): Promise<{
    checkoutUrl: string;
  }> {
    const setup =
      this.readTrustedSetup(
        result,
      );

    const reference =
      `MOVA-CARD-${setup.setupId.replace(
        /-/g,
        '',
      )}`;

    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () =>
          controller.abort(),
        12_000,
      );

    let response:
      Response;

    let body:
      | PaystackInitializeResponse
      | null =
      null;

    try {
      response =
        await fetch(
          'https://api.paystack.co/transaction/initialize',
          {
            method:
              'POST',

            headers: {
              Authorization:
                `Bearer ${this.secretKey}`,

              'Content-Type':
                'application/json',
            },

            body:
              JSON.stringify({
                email,

                amount:
                  String(
                    setup.amountMinor,
                  ),

                currency:
                  setup.currency,

                reference,

                channels: [
                  'card',
                ],

                metadata:
                  JSON.stringify(
                    {
                      purpose:
                        'payment_method_setup',

                      movaPaymentMethodSetupId:
                        setup.setupId,
                    },
                  ),
              }),

            signal:
              controller.signal,
          },
        );

      try {
        body =
          (await response.json()) as
            PaystackInitializeResponse;
      } catch {
        body =
          null;
      }
    } catch (
      error: unknown
    ) {
      await this.failSetupBestEffort(
        userId,
        setup.setupId,
      );

      if (
        error instanceof
          Error &&
        error.name ===
          'AbortError'
      ) {
        throw new ServiceUnavailableException(
          'Secure card setup timed out. Please try again.',
        );
      }

      throw new ServiceUnavailableException(
        'Secure card setup is temporarily unavailable.',
      );
    } finally {
      clearTimeout(
        timeout,
      );
    }

    if (
      !response.ok ||
      body?.status !==
        true ||
      typeof body.data
        ?.authorization_url !==
        'string' ||
      typeof body.data
        ?.access_code !==
        'string' ||
      typeof body.data
        ?.reference !==
        'string'
    ) {
      await this.failSetupBestEffort(
        userId,
        setup.setupId,
      );

      throw new ServiceUnavailableException(
        'Secure card setup is temporarily unavailable.',
      );
    }

    if (
      body.data.reference !==
      reference
    ) {
      await this.failSetupBestEffort(
        userId,
        setup.setupId,
      );

      throw new ServiceUnavailableException(
        'The payment provider returned an invalid card setup reference.',
      );
    }

    const checkoutUrl =
      this.validateCheckoutUrl(
        body.data
          .authorization_url,
      );

    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } =
      await admin.rpc(
        'bind_payment_method_setup_checkout',
        {
          p_user_id:
            userId,

          p_setup_id:
            setup.setupId,

          p_provider_reference:
            reference,

          p_provider_checkout_id:
            body.data
              .access_code,

          p_provider_checkout_url:
            checkoutUrl,
        },
      );

    if (
      error ||
      !data
    ) {
      await this.failSetupBestEffort(
        userId,
        setup.setupId,
      );

      throw new ServiceUnavailableException(
        'Secure card setup was created but could not be saved. Please try again.',
      );
    }

    const bind =
      data as
        BindSetupResult;

    switch (
      bind.status
    ) {
      case 'ready':
      case 'existing': {
        const storedUrl =
          typeof bind.checkoutUrl ===
            'string'
            ? bind.checkoutUrl
            : checkoutUrl;

        return {
          checkoutUrl:
            this.validateCheckoutUrl(
              storedUrl,
            ),
        };
      }

      case 'expired':
        throw new ConflictException(
          'This card setup attempt expired. Start again.',
        );

      case 'conflict':
        throw new ConflictException(
          'This card setup attempt already has different provider details.',
        );

      case 'not_available':
        throw new ConflictException(
          'This card setup attempt is no longer available.',
        );

      case 'not_found':
        throw new ServiceUnavailableException(
          'The card setup request could not be found.',
        );

      case 'invalid':
        throw new ServiceUnavailableException(
          'The payment provider returned invalid card setup details.',
        );

      default:
        throw new ServiceUnavailableException(
          'Unable to save secure card setup right now.',
        );
    }
  }

  private readTrustedSetup(
    result:
      PrepareSetupResult,
  ): TrustedSetup {
    const setupId =
      result.setupId;

    const amountMinor =
      typeof result.amountMinor ===
        'string'
        ? Number(
            result.amountMinor,
          )
        : result.amountMinor;

    const currency =
      result.currency;

    const expiresAt =
      result.expiresAt;

    if (
      typeof setupId !==
        'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        setupId,
      ) ||
      amountMinor !==
        5000 ||
      currency !==
        'NGN' ||
      typeof expiresAt !==
        'string' ||
      !Number.isFinite(
        Date.parse(
          expiresAt,
        ),
      ) ||
      Date.parse(
        expiresAt,
      ) <=
        Date.now()
    ) {
      throw new ServiceUnavailableException(
        'The card setup request could not be loaded safely.',
      );
    }

    return {
      setupId,

      amountMinor:
        5000,

      currency:
        'NGN',

      expiresAt:
        new Date(
          expiresAt,
        ).toISOString(),
    };
  }

  private async failSetupBestEffort(
    userId: string,

    setupId: string,
  ) {
    try {
      const admin =
        this.supabase.createAdminClient();

      await admin.rpc(
        'fail_payment_method_setup',
        {
          p_user_id:
            userId,

          p_setup_id:
            setupId,
        },
      );
    } catch {
      /*
       * Best effort only.
       *
       * The original setup error is more useful to the caller.
       */
    }
  }

  private validateIdempotencyKey(
    value:
      | string
      | undefined,
  ) {
    const cleaned =
      value?.trim() ??
      '';

    if (
      !/^[A-Za-z0-9._:-]{8,200}$/.test(
        cleaned,
      )
    ) {
      throw new BadRequestException(
        'A valid Idempotency-Key header is required.',
      );
    }

    return cleaned;
  }

  private hashIdempotencyKey(
    value: string,
  ) {
    return createHash(
      'sha256',
    )
      .update(
        value,
        'utf8',
      )
      .digest(
        'hex',
      );
  }

  private validateCheckoutUrl(
    rawUrl: string,
  ) {
    try {
      const url =
        new URL(
          rawUrl,
        );

      if (
        url.protocol !==
          'https:' ||
        url.username ||
        url.password
      ) {
        throw new Error();
      }

      return url.toString();
    } catch {
      throw new ServiceUnavailableException(
        'The card setup checkout link is invalid.',
      );
    }
  }

  private isReasonableEmail(
    email: string,
  ) {
    return (
      email.length >=
        3 &&
      email.length <=
        320 &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
        email,
      )
    );
  }

  private isConfigured() {
    return (
      this.secretKey.startsWith(
        'sk_test_',
      ) ||
      this.secretKey.startsWith(
        'sk_live_',
      )
    );
  }
}