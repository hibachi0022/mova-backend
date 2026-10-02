import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createHash,
} from 'node:crypto';
import { SupabaseService } from '../supabase/supabase.service';
import { OutingSavedCardChargeDto } from './dto/outing-saved-card-charge.dto';
import { OutingsPaymentProviderService } from './outings-payment-provider.service';
import { OutingsService } from './outings.service';

type PrepareSavedCardResult = {
  status?: string;

  intentId?: string;

  paymentStatus?: string;

  selectedMemberId?: string;

  amountMinor?:
    | number
    | string;

  currency?: string;

  methodId?: string;

  paymentMethodId?: string;

  provider?: string;

  providerReference?: string;

  expiresAt?: string;
};

type BeginSavedCardChargeResult = {
  status?: string;

  intentId?: string;

  paymentStatus?: string;

  amountMinor?:
    | number
    | string;

  currency?: string;

  paymentMethodId?: string;

  providerReference?: string;
};

type FailSavedCardChargeResult = {
  status?: string;
};

type SavedPaymentMethodRow = {
  id: string;

  user_id: string;

  provider: string;

  provider_email:
    | string
    | null;

  provider_authorization_code:
    | string
    | null;

  reusable: boolean;

  disabled_at:
    | string
    | null;
};

type PaystackChargeAuthorizationResponse = {
  status?: boolean;

  message?: string;

  data?: {
    status?: string;

    reference?: string;
  };
};

type ProviderChargeResult = {
  status:
    | 'success'
    | 'processing'
    | 'failed';

  reference: string;
};

export type SavedCardChargeResponse = {
  status:
    | 'processing'
    | 'completed';
};

@Injectable()
export class OutingsSavedCardPaymentsService {
  private readonly logger =
    new Logger(
      OutingsSavedCardPaymentsService.name,
    );

  private readonly secretKey:
    string;

  constructor(
    private readonly supabase:
      SupabaseService,

    private readonly outings:
      OutingsService,

    private readonly paymentProvider:
      OutingsPaymentProviderService,

    private readonly config:
      ConfigService,
  ) {
    this.secretKey =
      this.config
        .get<string>(
          'PAYSTACK_SECRET_KEY',
        )
        ?.trim() ??
      '';
  }

  async charge(
    userId: string,
    outingId: string,
    input:
      OutingSavedCardChargeDto,
    idempotencyKey:
      | string
      | undefined,
  ): Promise<
    SavedCardChargeResponse
  > {
    const cleanKey =
      this.validateIdempotencyKey(
        idempotencyKey,
      );

    if (
      !this.isConfigured()
    ) {
      throw new ServiceUnavailableException(
        'Secure saved-card payments are not configured.',
      );
    }

    const outing =
      await this.outings.get(
        userId,
        outingId,
      );

    const availability =
      this.paymentProvider.availability(
        'card',
        outing.currency,
      );

    if (
      !availability.available
    ) {
      throw new UnprocessableEntityException(
        availability.reason ??
          'Saved card payments are unavailable for this outing.',
      );
    }

    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } =
      await admin.rpc(
        'prepare_outing_saved_card_payment_intent',
        {
          p_user_id:
            userId,

          p_outing_id:
            outingId,

          p_payment_method_id:
            input.paymentMethodId,

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
        'Unable to prepare the saved-card payment right now.',
      );
    }

    const prepared =
      data as
        PrepareSavedCardResult;

    switch (
      prepared.status
    ) {
      case 'created':
        break;

      case 'existing':
        /*
         * A retry may safely resume an intent that never progressed
         * beyond creation.
         *
         * Once the intent reaches processing, however, Paystack may
         * already have received the charge request. That state must
         * never automatically submit another provider charge.
         */
        if (
          prepared.paymentStatus ===
          'created'
        ) {
          break;
        }

        return this.handleExistingIntent(
          prepared,
        );

      case 'reconciliation_required':
        throw new ConflictException(
          'This outing has a payment that requires review before another payment can be started.',
        );

      case 'not_found':
        throw new NotFoundException(
          'Outing not found.',
        );

      case 'inactive':
        throw new ConflictException(
          'Payment is not available for this outing.',
        );

      case 'no_selection':
        throw new ConflictException(
          'Pick the payer before starting payment.',
        );

      case 'selection_unavailable':
        throw new ConflictException(
          'The selected payer is no longer eligible. Run payer selection again.',
        );

      case 'not_selected_payer':
        throw new ForbiddenException(
          'Only the selected payer can use a saved card for this payment.',
        );

      case 'no_amount':
        throw new ConflictException(
          'This outing has no bill to pay.',
        );

      case 'idempotency_conflict':
        throw new ConflictException(
          'This payment request was already used with different payment details.',
        );

      case 'already_paid':
        throw new ConflictException(
          'This outing has already been paid.',
        );

      case 'payment_in_progress':
        throw new ConflictException(
          'A payment for this outing is already in progress.',
        );

      case 'payment_method_not_found':
        throw new NotFoundException(
          'Saved payment method not found.',
        );

      case 'payment_method_unavailable':
        throw new ConflictException(
          'This saved payment method is no longer available.',
        );

      case 'payment_method_expired':
        throw new ConflictException(
          'This saved card has expired. Use another payment method.',
        );

      case 'invalid':
        throw new BadRequestException(
          'Unable to prepare this saved-card payment request.',
        );

      default:
        throw new ServiceUnavailableException(
          'Unable to prepare the saved-card payment right now.',
        );
    }

    const intentId =
      prepared.intentId;

    if (
      typeof intentId !==
        'string'
    ) {
      throw new ServiceUnavailableException(
        'The payment request could not be loaded safely.',
      );
    }

    const providerReference =
      this.providerReference(
        intentId,
      );

    const {
      data:
        beginData,
      error:
        beginError,
    } =
      await admin.rpc(
        'begin_outing_saved_card_charge',
        {
          p_user_id:
            userId,

          p_intent_id:
            intentId,

          p_payment_method_id:
            input.paymentMethodId,

          p_provider_reference:
            providerReference,
        },
      );

    if (
      beginError ||
      !beginData
    ) {
      throw new ServiceUnavailableException(
        'Unable to begin the saved-card payment right now.',
      );
    }

    const begin =
      beginData as
        BeginSavedCardChargeResult;

    switch (
      begin.status
    ) {
      case 'ready':
        break;

      case 'existing':
        return {
          status:
            'processing',
        };

      case 'already_completed':
        return {
          status:
            'completed',
        };

      case 'not_found':
        throw new NotFoundException(
          'Payment request not found.',
        );

      case 'payment_method_not_found':
        throw new NotFoundException(
          'Saved payment method not found.',
        );

      case 'payment_method_unavailable':
        throw new ConflictException(
          'This saved payment method is no longer available.',
        );

      case 'payment_method_expired':
        throw new ConflictException(
          'This saved card has expired. Use another payment method.',
        );

      case 'expired':
        throw new ConflictException(
          'This payment attempt expired. Start again.',
        );

      case 'conflict':
        throw new ConflictException(
          'This saved-card payment conflicts with an existing payment attempt.',
        );

      case 'not_available':
        throw new ConflictException(
          'This payment attempt is no longer available.',
        );

      case 'invalid':
        throw new BadRequestException(
          'Unable to begin this saved-card payment request.',
        );

      default:
        throw new ServiceUnavailableException(
          'Unable to begin the saved-card payment right now.',
        );
    }

    let paymentMethod:
      SavedPaymentMethodRow;

    try {
      paymentMethod =
        await this.loadPaymentMethod(
          userId,
          input.paymentMethodId,
        );
    } catch (
      error: unknown
    ) {
      await this.failBeforeProviderBestEffort(
        userId,
        intentId,
        providerReference,
      );

      throw error;
    }

    const amountMinor =
      this.safeMinorAmount(
        begin.amountMinor ??
          prepared.amountMinor,
      );

    const currency =
      this.safeCurrency(
        begin.currency ??
          prepared.currency,
      );

    let providerResult:
      ProviderChargeResult;

    try {
      providerResult =
        await this.chargeAuthorization(
          {
            intentId,

            outingId,

            reference:
              providerReference,

            email:
              paymentMethod
                .provider_email as
                string,

            authorizationCode:
              paymentMethod
                .provider_authorization_code as
                string,

            amountMinor,

            currency,
          },
        );
    } catch {
      this.logger.warn(
        'Saved-card charge response was uncertain; the payment remains processing until provider confirmation.',
      );

      return {
        status:
          'processing',
      };
    }

    if (
      providerResult.status ===
      'failed'
    ) {
      await this.failAfterProviderDecline(
        userId,
        intentId,
        providerReference,
      );

      throw new UnprocessableEntityException(
        'The saved card charge was declined. Use another payment method or try again later.',
      );
    }

    return {
      status:
        'processing',
    };
  }

  private handleExistingIntent(
    result:
      PrepareSavedCardResult,
  ): SavedCardChargeResponse {
    switch (
      result.paymentStatus
    ) {
      case 'completed':
        return {
          status:
            'completed',
        };

      case 'processing':
        return {
          status:
            'processing',
        };

      case 'created':
        throw new ConflictException(
          'This saved-card payment is already being prepared. Retry this same request.',
        );

      case 'checkout_ready':
        throw new ConflictException(
          'This payment request belongs to a different checkout flow.',
        );

      case 'failed':
      case 'cancelled':
      case 'expired':
        throw new ConflictException(
          'This saved-card payment attempt is no longer active. Start a new payment attempt.',
        );

      default:
        throw new ConflictException(
          'This saved-card payment attempt cannot be restarted.',
        );
    }
  }

  private async loadPaymentMethod(
    userId: string,
    paymentMethodId:
      string,
  ): Promise<
    SavedPaymentMethodRow
  > {
    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } =
      await admin
        .from(
          'payment_methods',
        )
        .select(
          'id, user_id, provider, provider_email, provider_authorization_code, reusable, disabled_at',
        )
        .eq(
          'id',
          paymentMethodId,
        )
        .eq(
          'user_id',
          userId,
        )
        .maybeSingle();

    if (
      error
    ) {
      throw new ServiceUnavailableException(
        'Unable to load the saved payment method right now.',
      );
    }

    if (!data) {
      throw new NotFoundException(
        'Saved payment method not found.',
      );
    }

    const method =
      data as
        SavedPaymentMethodRow;

    if (
      method.provider !==
        'paystack' ||
      method.reusable !==
        true ||
      method.disabled_at !==
        null
    ) {
      throw new ConflictException(
        'This saved payment method is no longer available.',
      );
    }

    const email =
      method.provider_email
        ?.trim()
        .toLowerCase() ??
      '';

    if (
      !this.isReasonableEmail(
        email,
      )
    ) {
      throw new ServiceUnavailableException(
        'The saved payment method could not be loaded safely.',
      );
    }

    const authorizationCode =
      method
        .provider_authorization_code
        ?.trim() ??
      '';

    if (
      authorizationCode.length <
        1 ||
      authorizationCode.length >
        200
    ) {
      throw new ServiceUnavailableException(
        'The saved payment method could not be loaded safely.',
      );
    }

    return {
      ...method,

      provider_email:
        email,

      provider_authorization_code:
        authorizationCode,
    };
  }

  private async chargeAuthorization(
    input: {
      intentId: string;

      outingId: string;

      reference: string;

      email: string;

      authorizationCode:
        string;

      amountMinor: number;

      currency: string;
    },
  ): Promise<
    ProviderChargeResult
  > {
    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () =>
          controller.abort(),
        12_000,
      );

    try {
      const response =
        await fetch(
          'https://api.paystack.co/transaction/charge_authorization',
          {
            method:
              'POST',

            headers: {
              Authorization:
                `Bearer ${this.secretKey}`,

              'Content-Type':
                'application/json',

              Accept:
                'application/json',
            },

            body:
              JSON.stringify({
                authorization_code:
                  input.authorizationCode,

                email:
                  input.email,

                amount:
                  String(
                    input.amountMinor,
                  ),

                currency:
                  input.currency,

                reference:
                  input.reference,

                metadata:
                  JSON.stringify(
                    {
                      movaIntentId:
                        input.intentId,

                      movaOutingId:
                        input.outingId,

                      movaSavedCardCharge:
                        true,
                    },
                  ),
              }),

            signal:
              controller.signal,
          },
        );

      const rawResponse =
        await response.text();

      const body =
        this.parseProviderResponse(
          rawResponse,
        );

      if (
        !response.ok ||
        body?.status !==
          true ||
        !body.data ||
        typeof body.data
          .reference !==
          'string' ||
        typeof body.data
          .status !==
          'string'
      ) {
        this.logger.warn(
          `Paystack saved-card charge returned an uncertain HTTP ${response.status} response.`,
        );

        throw new ServiceUnavailableException(
          'Saved-card payment confirmation is temporarily unavailable.',
        );
      }

      const reference =
        body.data
          .reference
          .trim();

      if (
        reference !==
        input.reference
      ) {
        this.logger.error(
          'Paystack saved-card charge returned an unexpected payment reference.',
        );

        throw new ServiceUnavailableException(
          'The payment provider returned an unexpected payment reference.',
        );
      }

      const status =
        body.data
          .status
          .trim()
          .toLowerCase();

      if (
        status ===
        'success'
      ) {
        return {
          status:
            'success',

          reference,
        };
      }

      if (
        status ===
          'failed' ||
        status ===
          'declined'
      ) {
        return {
          status:
            'failed',

          reference,
        };
      }

      return {
        status:
          'processing',

        reference,
      };
    } catch (
      error: unknown
    ) {
      if (
        error instanceof
        ServiceUnavailableException
      ) {
        throw error;
      }

      if (
        error instanceof
          Error &&
        error.name ===
          'AbortError'
      ) {
        throw new ServiceUnavailableException(
          'Saved-card payment confirmation timed out.',
        );
      }

      this.logger.warn(
        'Unable to confirm the saved-card charge response from Paystack.',
      );

      throw new ServiceUnavailableException(
        'Saved-card payment confirmation is temporarily unavailable.',
      );
    } finally {
      clearTimeout(
        timeout,
      );
    }
  }

  private parseProviderResponse(
    rawResponse:
      string,
  ):
    | PaystackChargeAuthorizationResponse
    | null {
    try {
      const parsed =
        JSON.parse(
          rawResponse,
        ) as unknown;

      if (
        !parsed ||
        typeof parsed !==
          'object' ||
        Array.isArray(
          parsed,
        )
      ) {
        return null;
      }

      return parsed as
        PaystackChargeAuthorizationResponse;
    } catch {
      return null;
    }
  }

  private async failAfterProviderDecline(
    userId: string,
    intentId: string,
    providerReference:
      string,
  ) {
    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } =
      await admin.rpc(
        'fail_outing_saved_card_charge',
        {
          p_user_id:
            userId,

          p_intent_id:
            intentId,

          p_provider_reference:
            providerReference,
        },
      );

    if (
      error ||
      !data
    ) {
      throw new ServiceUnavailableException(
        'The card charge failed but MOVA could not safely finalize the payment attempt.',
      );
    }

    const result =
      data as
        FailSavedCardChargeResult;

    switch (
      result.status
    ) {
      case 'failed':
      case 'existing':
        return;

      case 'already_completed':
        return;

      case 'not_found':
        throw new NotFoundException(
          'Payment request not found.',
        );

      case 'conflict':
      case 'not_available':
        throw new ConflictException(
          'The payment attempt changed while the provider response was being processed.',
        );

      case 'invalid':
        throw new BadRequestException(
          'Unable to finalize this payment attempt.',
        );

      default:
        throw new ServiceUnavailableException(
          'Unable to finalize the failed saved-card payment.',
        );
    }
  }

  private async failBeforeProviderBestEffort(
    userId: string,
    intentId: string,
    providerReference:
      string,
  ) {
    try {
      const admin =
        this.supabase.createAdminClient();

      await admin.rpc(
        'fail_outing_saved_card_charge',
        {
          p_user_id:
            userId,

          p_intent_id:
            intentId,

          p_provider_reference:
            providerReference,
        },
      );
    } catch {
      this.logger.warn(
        'Unable to release a saved-card payment intent before the provider was contacted.',
      );
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

  private providerReference(
    intentId: string,
  ) {
    if (
      !/^[0-9a-f-]{36}$/i.test(
        intentId,
      )
    ) {
      throw new ServiceUnavailableException(
        'The payment request could not be loaded safely.',
      );
    }

    return `MOVA-${intentId.replace(
      /-/g,
      '',
    )}`;
  }

  private safeMinorAmount(
    value:
      | number
      | string
      | undefined,
  ) {
    const amount =
      typeof value ===
        'string'
        ? Number(
            value,
          )
        : value;

    if (
      !Number.isSafeInteger(
        amount,
      ) ||
      (amount ?? 0) <=
        0
    ) {
      throw new ServiceUnavailableException(
        'The payment amount could not be loaded safely.',
      );
    }

    return amount as
      number;
  }

  private safeCurrency(
    value:
      | string
      | undefined,
  ) {
    const currency =
      value
        ?.trim()
        .toUpperCase() ??
      '';

    if (
      !/^[A-Z]{3}$/.test(
        currency,
      )
    ) {
      throw new ServiceUnavailableException(
        'The payment currency could not be loaded safely.',
      );
    }

    return currency;
  }

  private isReasonableEmail(
    email: string,
  ) {
    return (
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