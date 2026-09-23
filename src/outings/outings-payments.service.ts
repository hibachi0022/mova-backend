import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  createHash,
} from 'node:crypto';
import { SupabaseService } from '../supabase/supabase.service';
import {
  OutingCheckoutDto,
} from './dto/outing-checkout.dto';
import {
  OutingsPaymentProviderService,
} from './outings-payment-provider.service';
import {
  OutingsService,
} from './outings.service';

type PreparePaymentResult = {
  status?: string;
  intentId?: string;
  paymentStatus?: string;
  selectedMemberId?:
    string;
  amountMinor?:
    number | string;
  currency?: string;
  methodId?: string;
  expiresAt?: string;
};

type AttachCheckoutResult = {
  status?: string;
  intentId?: string;
  checkoutUrl?: string;
  expiresAt?: string;
  paymentStatus?: string;
};

type PaymentIntentRow = {
  id: string;
  status: string;
  checkout_url:
    | string
    | null;
  expires_at: string;
};

@Injectable()
export class OutingsPaymentsService {
  constructor(
    private readonly supabase:
      SupabaseService,

    private readonly outings:
      OutingsService,

    private readonly provider:
      OutingsPaymentProviderService,
  ) {}

  async options(
    userId: string,
    outingId: string,
  ) {
    const outing =
      await this.outings.get(
        userId,
        outingId,
      );

    return this.provider.choices(
      {
        currency:
          outing.currency,
        amountMinor:
          outing.amountMinor,
        hasSelectedPayer:
          Boolean(
            outing.selectedMemberId,
          ),
      },
    );
  }

  async checkout(
    userId: string,
    email:
      | string
      | undefined,
    outingId: string,
    input:
      OutingCheckoutDto,
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

    if (
      !email ||
      !this.isReasonableEmail(
        email,
      )
    ) {
      throw new UnprocessableEntityException(
        'A valid account email is required for secure checkout.',
      );
    }

    /*
     * Membership and outing existence
     * are verified here before we expose
     * method/provider availability.
     */
    const outing =
      await this.outings.get(
        userId,
        outingId,
      );

    const availability =
      this.provider.availability(
        input.methodId,
        outing.currency,
      );

    if (
      !availability.available
    ) {
      throw new UnprocessableEntityException(
        availability.reason ??
          'This payment method is unavailable.',
      );
    }

    if (
      outing.amountMinor <=
      0
    ) {
      throw new ConflictException(
        'This outing has no bill to pay.',
      );
    }

    if (
      !outing.selectedMemberId
    ) {
      throw new ConflictException(
        'Pick the payer before starting payment.',
      );
    }

    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } =
      await admin.rpc(
        'prepare_outing_payment_intent',
        {
          p_user_id:
            userId,
          p_outing_id:
            outingId,
          p_method_id:
            input.methodId,
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
        'Unable to prepare secure checkout right now.',
      );
    }

    const result =
      data as
        PreparePaymentResult;

    switch (
      result.status
    ) {
      case 'created':
        break;

      case 'existing':
        return this.handleExistingIntent(
          userId,
          outingId,
          email,
          input,
          result,
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
          'Only the selected payer can start this payment.',
        );

      case 'no_amount':
        throw new ConflictException(
          'This outing has no bill to pay.',
        );

      case 'idempotency_conflict':
        throw new ConflictException(
          'This payment request was already used with different checkout details.',
        );

      case 'already_paid':
        throw new ConflictException(
          'This outing has already been paid.',
        );

      case 'payment_in_progress':
        throw new ConflictException(
          'A payment for this outing is already in progress.',
        );

      case 'invalid':
        throw new BadRequestException(
          'Unable to prepare this payment request.',
        );

      default:
        throw new ServiceUnavailableException(
          'Unable to prepare secure checkout right now.',
        );
    }

    return this.initializeAndAttachCheckout(
      userId,
      outingId,
      email,
      input,
      result,
    );
  }

  private async handleExistingIntent(
    userId: string,
    outingId: string,
    email: string,
    input:
      OutingCheckoutDto,
    result:
      PreparePaymentResult,
  ): Promise<{
    checkoutUrl: string;
  }> {
    if (
      typeof result.intentId !==
      'string'
    ) {
      throw new ServiceUnavailableException(
        'The payment request could not be loaded.',
      );
    }

    if (
      result.paymentStatus ===
      'checkout_ready'
    ) {
      const existing =
        await this.loadIntent(
          result.intentId,
        );

      if (
        existing &&
        existing.status ===
          'checkout_ready' &&
        existing.checkout_url &&
        Date.parse(
          existing.expires_at,
        ) >
          Date.now()
      ) {
        return {
          checkoutUrl:
            this.validateStoredCheckoutUrl(
              existing
                .checkout_url,
            ),
        };
      }
    }

    if (
      result.paymentStatus ===
      'created'
    ) {
      return this.initializeAndAttachCheckout(
        userId,
        outingId,
        email,
        input,
        result,
      );
    }

    if (
      result.paymentStatus ===
      'completed'
    ) {
      throw new ConflictException(
        'This outing has already been paid.',
      );
    }

    if (
      result.paymentStatus ===
      'processing'
    ) {
      throw new ConflictException(
        'This payment is already being processed.',
      );
    }

    throw new ConflictException(
      'This checkout attempt is no longer active. Start a new payment attempt.',
    );
  }

  private async initializeAndAttachCheckout(
    userId: string,
    outingId: string,
    email: string,
    input:
      OutingCheckoutDto,
    result:
      PreparePaymentResult,
  ): Promise<{
    checkoutUrl: string;
  }> {
    const intentId =
      result.intentId;

    const currency =
      result.currency;

    const expiresAt =
      result.expiresAt;

    const amountMinor =
      this.safeMinorAmount(
        result.amountMinor,
      );

    if (
      typeof intentId !==
        'string' ||
      typeof currency !==
        'string' ||
      typeof expiresAt !==
        'string' ||
      !Number.isFinite(
        Date.parse(
          expiresAt,
        ),
      )
    ) {
      throw new ServiceUnavailableException(
        'The payment request could not be loaded safely.',
      );
    }

    const checkout =
      await this.provider.initializeCheckout(
        {
          intentId,
          outingId,
          email,
          amountMinor,
          currency,
          methodId:
            input.methodId,
          expiresAt,
        },
      );

    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } =
      await admin.rpc(
        'attach_outing_payment_checkout',
        {
          p_user_id:
            userId,
          p_intent_id:
            intentId,
          p_provider:
            checkout.provider,
          p_provider_checkout_id:
            checkout.providerCheckoutId,
          p_provider_reference:
            checkout.providerReference,
          p_checkout_url:
            checkout.checkoutUrl,
          p_expires_at:
            checkout.expiresAt,
        },
      );

    if (
      error ||
      !data
    ) {
      throw new ServiceUnavailableException(
        'Secure checkout was created but could not be saved. Please try again.',
      );
    }

    const attach =
      data as
        AttachCheckoutResult;

    switch (
      attach.status
    ) {
      case 'ready':
      case 'existing': {
        const checkoutUrl =
          typeof attach.checkoutUrl ===
          'string'
            ? attach.checkoutUrl
            : checkout.checkoutUrl;

        return {
          checkoutUrl:
            this.validateStoredCheckoutUrl(
              checkoutUrl,
            ),
        };
      }

      case 'not_found':
        throw new NotFoundException(
          'Payment request not found.',
        );

      case 'expired':
        throw new ConflictException(
          'This checkout attempt expired. Start again.',
        );

      case 'conflict':
        throw new ConflictException(
          'This checkout attempt already has different provider details.',
        );

      case 'not_available':
        throw new ConflictException(
          'This checkout attempt is no longer available.',
        );

      case 'invalid':
        throw new BadRequestException(
          'The payment provider returned invalid checkout details.',
        );

      default:
        throw new ServiceUnavailableException(
          'Unable to save secure checkout right now.',
        );
    }
  }

  private async loadIntent(
    intentId: string,
  ): Promise<
    PaymentIntentRow | null
  > {
    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } =
      await admin
        .from(
          'outing_payment_intents',
        )
        .select(
          'id, status, checkout_url, expires_at',
        )
        .eq(
          'id',
          intentId,
        )
        .maybeSingle();

    if (error) {
      throw new ServiceUnavailableException(
        'Unable to reload secure checkout right now.',
      );
    }

    return data
      ? (data as
          PaymentIntentRow)
      : null;
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

    return amount as number;
  }

  private validateStoredCheckoutUrl(
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
        'The stored checkout link is invalid.',
      );
    }
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
}