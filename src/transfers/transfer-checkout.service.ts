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

type PrepareTransferPaymentResult = {
  status?:
    string;

  intentId?:
    string;

  paymentStatus?:
    string;

  amountMinor?:
    number | string;

  feeMinor?:
    number | string;

  totalMinor?:
    number | string;

  currency?:
    string;

  paymentMethodId?:
    string;
};

type BeginTransferChargeResult = {
  status?:
    string;

  intentId?:
    string;

  amountMinor?:
    number | string;

  feeMinor?:
    number | string;

  totalMinor?:
    number | string;

  currency?:
    string;

  paymentMethodId?:
    string;

  providerReference?:
    string;
};

type FailTransferPaymentResult = {
  status?:
    string;
};

type SavedPaymentMethodRow = {
  id:
    string;

  user_id:
    string;

  provider:
    string;

  provider_email:
    string | null;

  provider_authorization_code:
    string | null;

  reusable:
    boolean;

  disabled_at:
    string | null;
};

type PaystackChargeAuthorizationResponse = {
  status?:
    boolean;

  message?:
    string;

  data?: {
    status?:
      string;

    reference?:
      string;
  };
};

type ProviderChargeResult = {
  status:
    | 'success'
    | 'processing'
    | 'failed';

  reference:
    string;
};

export type TransferCheckoutResponse = {
  status:
    | 'processing'
    | 'completed';
};

@Injectable()
export class TransferCheckoutService {
  private readonly logger =
    new Logger(
      TransferCheckoutService.name,
    );

  private readonly secretKey:
    string;

  constructor(
    private readonly supabase:
      SupabaseService,

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

  async checkout(
    senderUserId:
      string,

    quoteId:
      string,

    idempotencyKey:
      | string
      | undefined,
  ): Promise<
    TransferCheckoutResponse
  > {
    const cleanKey =
      this.validateIdempotencyKey(
        idempotencyKey,
      );

    if (
      !this.isConfigured()
    ) {
      throw new ServiceUnavailableException(
        'Secure transfer payments are not configured.',
      );
    }

    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } =
      await admin.rpc(
        'prepare_friend_transfer_payment',
        {
          p_sender_user_id:
            senderUserId,

          p_quote_id:
            quoteId,

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
        'Unable to prepare the transfer payment right now.',
      );
    }

    const prepared =
      data as
        PrepareTransferPaymentResult;

    switch (
      prepared.status
    ) {
      case 'created':
        break;

      case 'existing':
        if (
          prepared.paymentStatus ===
          'created'
        ) {
          break;
        }

        return this.handleExistingIntent(
          prepared,
        );

      case 'already_paid':
        return {
          status:
            'completed',
        };

      case 'expired':
        throw new ConflictException(
          'This transfer quote expired. Review the transfer again.',
        );

      case 'not_available':
        throw new ConflictException(
          'This transfer quote is no longer available.',
        );

      case 'not_found':
        throw new NotFoundException(
          'Transfer quote not found.',
        );

      case 'not_friends':
        throw new ConflictException(
          'You can only send money to an accepted friend.',
        );

      case 'blocked':
        throw new ForbiddenException(
          'Money transfers are unavailable between these accounts.',
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

      case 'recipient_account_unavailable':
        throw new ConflictException(
          'The recipient’s receiving account is no longer available. Review the transfer again.',
        );

      case 'idempotency_conflict':
        throw new ConflictException(
          'This transfer payment request was already used with different details.',
        );

      case 'reconciliation_required':
        throw new ConflictException(
          'This transfer requires review before another payment can be started.',
        );

      case 'payment_in_progress':
        throw new ConflictException(
          'A payment for this transfer is already in progress.',
        );

      case 'invalid':
        throw new BadRequestException(
          'Unable to prepare this transfer payment request.',
        );

      default:
        throw new ServiceUnavailableException(
          'Unable to determine the transfer payment state.',
        );
    }

    const intentId =
      this.requiredUuid(
        prepared.intentId,
        'payment request',
      );

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
        'begin_friend_transfer_saved_card_charge',
        {
          p_sender_user_id:
            senderUserId,

          p_intent_id:
            intentId,

          p_provider_reference:
            providerReference,
        },
      );

    if (
      beginError ||
      !beginData
    ) {
      throw new ServiceUnavailableException(
        'Unable to begin the transfer payment right now.',
      );
    }

    const begin =
      beginData as
        BeginTransferChargeResult;

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
          'Transfer payment request not found.',
        );

      case 'payment_method_not_found':
        throw new NotFoundException(
          'Saved payment method not found.',
        );

      case 'payment_method_unavailable':
        throw new ConflictException(
          'This saved payment method is no longer available.',
        );

      case 'recipient_account_unavailable':
        throw new ConflictException(
          'The recipient’s receiving account is no longer available.',
        );

      case 'expired':
        throw new ConflictException(
          'This transfer quote expired. Review the transfer again.',
        );

      case 'conflict':
        throw new ConflictException(
          'This transfer payment conflicts with an existing payment attempt.',
        );

      case 'not_available':
        throw new ConflictException(
          'This transfer payment attempt is no longer available.',
        );

      case 'invalid':
        throw new BadRequestException(
          'Unable to begin this transfer payment request.',
        );

      default:
        throw new ServiceUnavailableException(
          'Unable to begin the transfer payment right now.',
        );
    }

    const paymentMethodId =
      this.requiredUuid(
        begin.paymentMethodId ??
          prepared.paymentMethodId,
        'saved payment method',
      );

    let paymentMethod:
      SavedPaymentMethodRow;

    try {
      paymentMethod =
        await this.loadPaymentMethod(
          senderUserId,
          paymentMethodId,
        );
    } catch (
      error: unknown
    ) {
      await this.failBeforeProviderBestEffort(
        senderUserId,
        intentId,
        providerReference,
      );

      throw error;
    }

    const totalMinor =
      this.safeMinorAmount(
        begin.totalMinor ??
          prepared.totalMinor,
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
        await this.chargeAuthorization({
          intentId,

          quoteId,

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

          amountMinor:
            totalMinor,

          currency,
        });
    } catch {
      /*
       * Paystack may have received the charge even if MOVA did not
       * receive a conclusive HTTP response.
       *
       * Never automatically submit another charge in that situation.
       * Leave the payment as processing for webhook/provider
       * reconciliation.
       */
      this.logger.warn(
        'Friend-transfer card charge response was uncertain; payment remains processing until provider confirmation.',
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
        senderUserId,
        intentId,
        providerReference,
      );

      throw new UnprocessableEntityException(
        'The saved card charge was declined. Use another payment method or try again later.',
      );
    }

    /*
     * Even when Paystack's immediate response says success, MOVA does
     * not finalize the financial transfer here.
     *
     * Final settlement happens only after independent verification of
     * the provider transaction.
     */
    return {
      status:
        'processing',
    };
  }

  private handleExistingIntent(
    result:
      PrepareTransferPaymentResult,
  ): TransferCheckoutResponse {
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
          'This transfer payment is already being prepared. Retry the same request.',
        );

      case 'failed':
      case 'cancelled':
      case 'expired':
        throw new ConflictException(
          'This transfer payment attempt is no longer active. Start a new payment attempt.',
        );

      default:
        throw new ConflictException(
          'This transfer payment attempt cannot be restarted.',
        );
    }
  }

  private async loadPaymentMethod(
    userId:
      string,

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

    if (error) {
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
      intentId:
        string;

      quoteId:
        string;

      reference:
        string;

      email:
        string;

      authorizationCode:
        string;

      amountMinor:
        number;

      currency:
        string;
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
                  JSON.stringify({
                    movaFriendTransfer:
                      true,

                    movaTransferIntentId:
                      input.intentId,

                    movaTransferQuoteId:
                      input.quoteId,
                  }),
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
          `Paystack friend-transfer card charge returned an uncertain HTTP ${response.status} response.`,
        );

        throw new ServiceUnavailableException(
          'Transfer payment confirmation is temporarily unavailable.',
        );
      }

      const reference =
        body.data
          .reference
          .trim()
          .toLowerCase();

      if (
        reference !==
        input.reference
      ) {
        this.logger.error(
          'Paystack friend-transfer charge returned an unexpected payment reference.',
        );

        throw new ServiceUnavailableException(
          'The payment provider returned an unexpected transfer reference.',
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
          'Transfer payment confirmation timed out.',
        );
      }

      this.logger.warn(
        'Unable to confirm the friend-transfer card charge response from Paystack.',
      );

      throw new ServiceUnavailableException(
        'Transfer payment confirmation is temporarily unavailable.',
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
        ) as
          unknown;

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
    senderUserId:
      string,

    intentId:
      string,

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
        'fail_friend_transfer_payment',
        {
          p_sender_user_id:
            senderUserId,

          p_intent_id:
            intentId,

          p_provider_reference:
            providerReference,

          p_reason:
            'provider_declined',
        },
      );

    if (
      error ||
      !data
    ) {
      throw new ServiceUnavailableException(
        'The card charge failed but MOVA could not safely finalize the transfer payment attempt.',
      );
    }

    const result =
      data as
        FailTransferPaymentResult;

    switch (
      result.status
    ) {
      case 'failed':
      case 'existing':
      case 'already_completed':
        return;

      case 'not_found':
        throw new NotFoundException(
          'Transfer payment request not found.',
        );

      case 'conflict':
        throw new ConflictException(
          'The transfer payment changed while the provider response was being processed.',
        );

      case 'invalid':
        throw new BadRequestException(
          'Unable to finalize this transfer payment.',
        );

      default:
        throw new ServiceUnavailableException(
          'Unable to finalize the failed transfer payment.',
        );
    }
  }

  private async failBeforeProviderBestEffort(
    senderUserId:
      string,

    intentId:
      string,

    providerReference:
      string,
  ) {
    try {
      const admin =
        this.supabase.createAdminClient();

      await admin.rpc(
        'fail_friend_transfer_payment',
        {
          p_sender_user_id:
            senderUserId,

          p_intent_id:
            intentId,

          p_provider_reference:
            providerReference,

          p_reason:
            'payment_method_load_failed',
        },
      );
    } catch {
      this.logger.warn(
        'Unable to release a friend-transfer payment intent before Paystack was contacted.',
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
    value:
      string,
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
    intentId:
      string,
  ) {
    const cleanIntentId =
      this.requiredUuid(
        intentId,
        'payment request',
      );

    return `mova-ft-${cleanIntentId
      .replace(
        /-/g,
        '',
      )
      .toLowerCase()}`;
  }

  private requiredUuid(
    value:
      unknown,

    label:
      string,
  ) {
    if (
      typeof value !==
        'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
      )
    ) {
      throw new ServiceUnavailableException(
        `The ${label} could not be loaded safely.`,
      );
    }

    return value;
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
        'The transfer payment amount could not be loaded safely.',
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
      currency !==
        'NGN'
    ) {
      throw new ServiceUnavailableException(
        'The transfer payment currency could not be loaded safely.',
      );
    }

    return currency;
  }

  private isReasonableEmail(
    value:
      string,
  ) {
    return (
      value.length <=
        320 &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
        value,
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