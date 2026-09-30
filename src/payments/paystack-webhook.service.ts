import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createHash,
  createHmac,
  timingSafeEqual,
} from 'node:crypto';
import { SupabaseService } from '../supabase/supabase.service';

type PaystackWebhookEvent = {
  event?: unknown;

  data?: {
    reference?: unknown;
  };
};

type PaystackAuthorization = {
  authorization_code?: unknown;
  last4?: unknown;
  exp_month?: unknown;
  exp_year?: unknown;
  channel?: unknown;
  card_type?: unknown;
  bank?: unknown;
  country_code?: unknown;
  brand?: unknown;
  reusable?: unknown;
  signature?: unknown;
};

type PaystackCustomer = {
  email?: unknown;
  customer_code?: unknown;
};

type PaystackVerifyResponse = {
  status?: boolean;
  message?: string;

  data?: {
    id?:
      | string
      | number;

    status?: string;
    reference?: string;

    amount?: number;

    requested_amount?:
      number;

    currency?: string;

    paid_at?:
      | string
      | null;

    channel?: string;

    authorization?:
      PaystackAuthorization;

    customer?:
      PaystackCustomer;
  };
};

type VerifiedTransaction =
  NonNullable<
    PaystackVerifyResponse['data']
  >;

type SettlementResult = {
  status?: string;
  intentId?: string;
  outingId?: string;
  paymentStatus?: string;
  reason?: string;
  resolution?: string;
};

type SavePaymentMethodResult = {
  status?: string;
  methodId?: string;
};

type ReusableCardAuthorization = {
  customerCode: string;
  email: string;
  authorizationCode: string;
  signature: string;
  network: string;
  last4: string;
  expMonth: number;
  expYear: number;

  bank:
    | string
    | null;

  countryCode:
    | string
    | null;
};

export type PaystackWebhookResult = {
  received: true;

  status:
    | 'completed'
    | 'already_completed'
    | 'ignored'
    | 'mismatch'
    | 'conflict'
    | 'reconciliation_required'
    | 'reconciliation_resolved'
    | 'invalid';
};

@Injectable()
export class PaystackWebhookService {
  private readonly logger =
    new Logger(
      PaystackWebhookService.name,
    );

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

  async handle(
    rawBody:
      | Buffer
      | undefined,

    signature:
      | string
      | undefined,
  ): Promise<PaystackWebhookResult> {
    if (
      !rawBody ||
      rawBody.length ===
        0
    ) {
      throw new ServiceUnavailableException(
        'Webhook raw body is unavailable.',
      );
    }

    this.verifySignature(
      rawBody,
      signature,
    );

    const payloadHash =
      createHash(
        'sha256',
      )
        .update(
          rawBody,
        )
        .digest(
          'hex',
        );

    const event =
      this.parseWebhookEvent(
        rawBody,
      );

    if (
      event.event !==
      'charge.success'
    ) {
      return {
        received:
          true,

        status:
          'ignored',
      };
    }

    const reference =
      event.data
        ?.reference;

    if (
      typeof reference !==
        'string' ||
      !this.isValidReference(
        reference,
      )
    ) {
      throw new BadRequestException(
        'Webhook payment reference is invalid.',
      );
    }

    /*
     * Never trust financial or card details directly from the webhook.
     *
     * The webhook tells MOVA only which provider transaction changed.
     * We independently retrieve the transaction from Paystack's Verify
     * Transaction endpoint.
     */
    const verified =
      await this.verifyTransaction(
        reference,
      );

    if (
      verified.status !==
        'success'
    ) {
      throw new ServiceUnavailableException(
        'The payment is not yet verifiable as successful.',
      );
    }

    if (
      verified.reference !==
        reference
    ) {
      throw new ServiceUnavailableException(
        'The verified payment reference did not match the webhook.',
      );
    }

    const transactionId =
      this.safeTransactionId(
        verified.id,
      );

    /*
     * Paystack amount:
     *
     * Actual amount charged to the payer. This may include Paystack's
     * customer-paid transaction fee.
     */
    const amountMinor =
      this.safeAmount(
        verified.amount,
        'payment amount',
      );

    /*
     * Paystack requested_amount:
     *
     * Original MOVA amount supplied when checkout was initialized.
     *
     * Settlement compares this against MOVA's trusted outing amount.
     */
    const requestedAmountMinor =
      this.safeAmount(
        verified.requested_amount,
        'requested payment amount',
      );

    const currency =
      this.safeCurrency(
        verified.currency,
      );

    const channel =
      this.safeChannel(
        verified.channel,
      );

    const paidAt =
      this.safePaidAt(
        verified.paid_at,
      );

    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } =
      await admin.rpc(
        'complete_outing_payment_from_provider',
        {
          p_provider:
            'paystack',

          p_event_type:
            'charge.success',

          p_provider_reference:
            reference,

          p_provider_transaction_id:
            transactionId,

          p_amount_minor:
            amountMinor,

          p_requested_amount_minor:
            requestedAmountMinor,

          p_currency:
            currency,

          p_channel:
            channel,

          p_paid_at:
            paidAt,

          p_payload_hash:
            payloadHash,
        },
      );

    if (
      error ||
      !data
    ) {
      this.logger.error(
        'Unable to persist verified Paystack settlement.',
      );

      throw new ServiceUnavailableException(
        'Unable to settle the verified payment right now.',
      );
    }

    const result =
      data as
        SettlementResult;

    switch (
      result.status
    ) {
      case 'completed':
        /*
         * Financial settlement succeeded first.
         *
         * Saving the reusable authorization is deliberately secondary.
         * The database RPC will independently check the original
         * save-payment-method consent on this MOVA payment intent.
         */
        await this.maybeSavePaymentMethod(
          reference,
          paidAt,
          verified,
        );

        return {
          received:
            true,

          status:
            'completed',
        };

      case 'already_completed':
        /*
         * Also retry payment-method persistence on an idempotent webhook
         * retry. This lets a transient database failure during card-save
         * recover without ever settling the payment twice.
         */
        await this.maybeSavePaymentMethod(
          reference,
          paidAt,
          verified,
        );

        return {
          received:
            true,

          status:
            'already_completed',
        };

      case 'reconciliation_resolved':
        this.logger.log(
          `Paystack payment retry acknowledged after reconciliation was resolved as ${
            result.resolution ??
            'resolved'
          }.`,
        );

        return {
          received:
            true,

          status:
            'reconciliation_resolved',
        };

      case 'not_found':
        return {
          received:
            true,

          status:
            'ignored',
        };

      case 'mismatch':
        this.logger.error(
          'Verified Paystack payment does not match the MOVA payment intent.',
        );

        return {
          received:
            true,

          status:
            'mismatch',
        };

      case 'conflict':
        this.logger.error(
          'Verified Paystack transaction conflicts with existing MOVA settlement data.',
        );

        return {
          received:
            true,

          status:
            'conflict',
        };

      case 'reconciliation_required':
        this.logger.warn(
          `Verified Paystack payment requires reconciliation${
            result.reason
              ? `: ${result.reason}`
              : '.'
          }`,
        );

        return {
          received:
            true,

          status:
            'reconciliation_required',
        };

      case 'invalid':
        this.logger.error(
          'Verified Paystack settlement was rejected as invalid by the database.',
        );

        return {
          received:
            true,

          status:
            'invalid',
        };

      default:
        throw new ServiceUnavailableException(
          'Unable to determine the payment settlement state.',
        );
    }
  }

  private async maybeSavePaymentMethod(
    reference: string,
    paidAt: string,
    verified:
      VerifiedTransaction,
  ) {
    /*
     * Only card transactions can create a reusable saved-card method.
     */
    if (
      verified.channel
        ?.trim()
        .toLowerCase() !==
      'card'
    ) {
      return;
    }

    const card =
      this.parseReusableCardAuthorization(
        verified,
      );

    /*
     * A missing, incomplete or non-reusable authorization does not make
     * the financial payment invalid.
     *
     * The payment remains completed; MOVA simply does not persist the
     * authorization.
     */
    if (!card) {
      return;
    }

    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } =
      await admin.rpc(
        'save_outing_payment_method_from_provider',
        {
          p_provider:
            'paystack',

          p_provider_reference:
            reference,

          p_provider_customer_code:
            card.customerCode,

          p_provider_email:
            card.email,

          p_provider_authorization_code:
            card.authorizationCode,

          p_provider_signature:
            card.signature,

          p_network:
            card.network,

          p_last4:
            card.last4,

          p_exp_month:
            card.expMonth,

          p_exp_year:
            card.expYear,

          p_bank:
            card.bank,

          p_country_code:
            card.countryCode,

          p_paid_at:
            paidAt,
        },
      );

    if (
      error ||
      !data
    ) {
      /*
       * Settlement has already succeeded.
       *
       * Return a temporary error so Paystack can retry the webhook.
       * Settlement is idempotent, and the next retry can attempt the
       * saved-card write again without charging or settling twice.
       */
      this.logger.error(
        'Verified payment completed, but reusable payment method persistence temporarily failed.',
      );

      throw new ServiceUnavailableException(
        'Payment was verified but the saved payment method could not be recorded right now.',
      );
    }

    const saveResult =
      data as
        SavePaymentMethodResult;

    switch (
      saveResult.status
    ) {
      case 'saved':
      case 'updated':
      case 'not_requested':
      case 'not_eligible':
      case 'not_found':
        /*
         * not_requested:
         *   The payer did not consent. Nothing is saved.
         *
         * not_eligible:
         *   Database state does not permit card saving.
         *
         * not_found:
         *   The account/payment disappeared after settlement.
         *
         * All of these are terminal outcomes and should not cause
         * webhook retry storms.
         */
        return;

      case 'conflict':
        /*
         * A provider authorization already belongs to a different
         * stored credential. Never reassign it automatically.
         */
        this.logger.error(
          'Reusable Paystack authorization conflicted with an existing saved payment method.',
        );

        return;

      case 'invalid':
        /*
         * Provider data passed our application validation but was
         * rejected by the database. Do not repeatedly retry a permanent
         * validation failure.
         */
        this.logger.error(
          'Reusable Paystack authorization was rejected by saved payment method validation.',
        );

        return;

      default:
        throw new ServiceUnavailableException(
          'Unable to determine the saved payment method state.',
        );
    }
  }

  private parseReusableCardAuthorization(
    verified:
      VerifiedTransaction,
  ):
    | ReusableCardAuthorization
    | null {
    const authorization =
      verified.authorization;

    const customer =
      verified.customer;

    if (
      !authorization ||
      !customer ||
      authorization.reusable !==
        true
    ) {
      return null;
    }

    const channel =
      this.cleanString(
        authorization.channel,
      )
        ?.toLowerCase();

    if (
      channel !==
      'card'
    ) {
      return null;
    }

    const customerCode =
      this.cleanString(
        customer.customer_code,
      );

    const email =
      this.cleanString(
        customer.email,
      )
        ?.toLowerCase();

    const authorizationCode =
      this.cleanString(
        authorization.authorization_code,
      );

    const signature =
      this.cleanString(
        authorization.signature,
      );

    const brand =
      this.cleanString(
        authorization.brand,
      );

    const cardType =
      this.cleanString(
        authorization.card_type,
      );

    const network =
      (
        brand ??
        cardType ??
        ''
      )
        .trim()
        .toLowerCase();

    const last4 =
      this.cleanString(
        authorization.last4,
      );

    const expMonth =
      this.safeSmallInteger(
        authorization.exp_month,
      );

    const expYear =
      this.safeSmallInteger(
        authorization.exp_year,
      );

    const bank =
      this.optionalLimitedString(
        authorization.bank,
        120,
      );

    const countryCode =
      this.optionalCountryCode(
        authorization.country_code,
      );

    if (
      !customerCode ||
      customerCode.length >
        120 ||
      !email ||
      email.length >
        320 ||
      !this.isReasonableEmail(
        email,
      ) ||
      !authorizationCode ||
      authorizationCode.length >
        200 ||
      !signature ||
      signature.length >
        200 ||
      network.length <
        1 ||
      network.length >
        40 ||
      !last4 ||
      !/^[0-9]{4}$/.test(
        last4,
      ) ||
      expMonth ===
        null ||
      expMonth <
        1 ||
      expMonth >
        12 ||
      expYear ===
        null ||
      expYear <
        2020 ||
      expYear >
        2200
    ) {
      this.logger.warn(
        'Paystack returned an incomplete reusable card authorization; the payment will remain completed without saving the card.',
      );

      return null;
    }

    return {
      customerCode,

      email,

      authorizationCode,

      signature,

      network,

      last4,

      expMonth,

      expYear,

      bank,

      countryCode,
    };
  }

  private verifySignature(
    rawBody: Buffer,

    signature:
      | string
      | undefined,
  ) {
    if (
      !this.isConfigured()
    ) {
      throw new ServiceUnavailableException(
        'Paystack webhook verification is not configured.',
      );
    }

    const cleanedSignature =
      signature
        ?.trim()
        .toLowerCase() ??
      '';

    if (
      !/^[0-9a-f]{128}$/.test(
        cleanedSignature,
      )
    ) {
      throw new UnauthorizedException(
        'Invalid Paystack webhook signature.',
      );
    }

    const expected =
      createHmac(
        'sha512',
        this.secretKey,
      )
        .update(
          rawBody,
        )
        .digest();

    const received =
      Buffer.from(
        cleanedSignature,
        'hex',
      );

    if (
      expected.length !==
        received.length ||
      !timingSafeEqual(
        expected,
        received,
      )
    ) {
      throw new UnauthorizedException(
        'Invalid Paystack webhook signature.',
      );
    }
  }

  private parseWebhookEvent(
    rawBody: Buffer,
  ): PaystackWebhookEvent {
    try {
      const parsed =
        JSON.parse(
          rawBody.toString(
            'utf8',
          ),
        ) as unknown;

      if (
        !parsed ||
        typeof parsed !==
          'object' ||
        Array.isArray(
          parsed,
        )
      ) {
        throw new Error();
      }

      return parsed as
        PaystackWebhookEvent;
    } catch {
      throw new BadRequestException(
        'Invalid Paystack webhook payload.',
      );
    }
  }

  private async verifyTransaction(
    reference: string,
  ) {
    if (
      !this.isConfigured()
    ) {
      throw new ServiceUnavailableException(
        'Paystack payment verification is not configured.',
      );
    }

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
          `https://api.paystack.co/transaction/verify/${encodeURIComponent(
            reference,
          )}`,
          {
            method:
              'GET',

            headers: {
              Authorization:
                `Bearer ${this.secretKey}`,

              Accept:
                'application/json',
            },

            signal:
              controller.signal,
          },
        );

      const rawResponse =
        await response.text();

      const body =
        this.parseVerifyResponse(
          rawResponse,
        );

      if (
        !response.ok ||
        body?.status !==
          true ||
        !body.data
      ) {
        this.logger.warn(
          `Paystack transaction verification failed with HTTP ${response.status}.`,
        );

        throw new ServiceUnavailableException(
          'Payment verification is temporarily unavailable.',
        );
      }

      return body.data;
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
          'Payment verification timed out.',
        );
      }

      this.logger.warn(
        'Unable to reach Paystack transaction verification.',
      );

      throw new ServiceUnavailableException(
        'Payment verification is temporarily unavailable.',
      );
    } finally {
      clearTimeout(
        timeout,
      );
    }
  }

  private parseVerifyResponse(
    rawResponse: string,
  ):
    | PaystackVerifyResponse
    | null {
    try {
      /*
       * Preserve Paystack transaction IDs that are larger than
       * JavaScript's safe integer range.
       */
      const safeJson =
        rawResponse.replace(
          /("id"\s*:\s*)(\d+)/,
          '$1"$2"',
        );

      return JSON.parse(
        safeJson,
      ) as
        PaystackVerifyResponse;
    } catch {
      return null;
    }
  }

  private safeTransactionId(
    value:
      | string
      | number
      | undefined,
  ) {
    if (
      typeof value ===
        'string' &&
      /^\d{1,30}$/.test(
        value,
      )
    ) {
      return value;
    }

    if (
      typeof value ===
        'number' &&
      Number.isSafeInteger(
        value,
      ) &&
      value >
        0
    ) {
      return String(
        value,
      );
    }

    throw new ServiceUnavailableException(
      'Paystack returned an invalid transaction ID.',
    );
  }

  private safeAmount(
    value:
      | number
      | undefined,

    label: string,
  ) {
    if (
      !Number.isSafeInteger(
        value,
      ) ||
      (value ?? 0) <=
        0
    ) {
      throw new ServiceUnavailableException(
        `Paystack returned an invalid ${label}.`,
      );
    }

    return value as number;
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
        'Paystack returned an invalid payment currency.',
      );
    }

    return currency;
  }

  private safeChannel(
    value:
      | string
      | undefined,
  ) {
    const channel =
      value
        ?.trim()
        .toLowerCase() ??
      '';

    if (
      channel.length <
        1 ||
      channel.length >
        40
    ) {
      throw new ServiceUnavailableException(
        'Paystack returned an invalid payment channel.',
      );
    }

    return channel;
  }

  private safePaidAt(
    value:
      | string
      | null
      | undefined,
  ) {
    if (
      typeof value !==
        'string' ||
      !Number.isFinite(
        Date.parse(
          value,
        ),
      )
    ) {
      throw new ServiceUnavailableException(
        'Paystack returned an invalid payment timestamp.',
      );
    }

    return new Date(
      value,
    ).toISOString();
  }

  private cleanString(
    value:
      unknown,
  ) {
    if (
      typeof value !==
      'string'
    ) {
      return null;
    }

    const cleaned =
      value.trim();

    return cleaned ||
      null;
  }

  private optionalLimitedString(
    value: unknown,
    maxLength: number,
  ) {
    const cleaned =
      this.cleanString(
        value,
      );

    if (!cleaned) {
      return null;
    }

    if (
      cleaned.length >
      maxLength
    ) {
      return null;
    }

    return cleaned;
  }

  private optionalCountryCode(
    value:
      unknown,
  ) {
    const cleaned =
      this.cleanString(
        value,
      )
        ?.toUpperCase();

    if (!cleaned) {
      return null;
    }

    if (
      !/^[A-Z]{2}$/.test(
        cleaned,
      )
    ) {
      return null;
    }

    return cleaned;
  }

  private safeSmallInteger(
    value:
      unknown,
  ) {
    if (
      typeof value ===
        'number'
    ) {
      return Number.isSafeInteger(
        value,
      )
        ? value
        : null;
    }

    if (
      typeof value ===
        'string' &&
      /^\d{1,4}$/.test(
        value.trim(),
      )
    ) {
      const parsed =
        Number(
          value,
        );

      return Number.isSafeInteger(
        parsed,
      )
        ? parsed
        : null;
    }

    return null;
  }

  private isReasonableEmail(
    email:
      string,
  ) {
    return (
      email.length <=
        320 &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
        email,
      )
    );
  }

  private isValidReference(
    reference: string,
  ) {
    return (
      reference.length >=
        1 &&
      reference.length <=
        200 &&
      /^[A-Za-z0-9.=_-]+$/.test(
        reference,
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