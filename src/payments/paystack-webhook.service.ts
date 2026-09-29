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
    currency?: string;

    paid_at?:
      | string
      | null;

    channel?: string;
  };
};

type SettlementResult = {
  status?: string;
  intentId?: string;
  outingId?: string;
  paymentStatus?: string;
  reason?: string;
  resolution?: string;
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

    /*
     * Paystack can deliver several event types to the same URL.
     *
     * MOVA currently settles outing payments only from charge.success.
     */
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
     * Do not trust the webhook body for financial values.
     *
     * Use only its reference and independently verify the transaction
     * with Paystack.
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

    const amountMinor =
      this.safeAmount(
        verified.amount,
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
        return {
          received:
            true,

          status:
            'completed',
        };

      case 'already_completed':
        return {
          received:
            true,

          status:
            'already_completed',
        };

      case 'reconciliation_resolved':
        /*
         * The provider payment was already manually reconciled.
         *
         * The important example is a late Paystack payment that MOVA
         * later recorded as refunded.
         *
         * A repeated Paystack webhook must be acknowledged rather than
         * returning 503 forever.
         */
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
        /*
         * A Paystack account can eventually contain transactions from
         * products other than MOVA outing payments.
         *
         * A valid transaction that has no MOVA payment intent is safely
         * acknowledged and ignored.
         */
        return {
          received:
            true,

          status:
            'ignored',
        };

      case 'mismatch':
        /*
         * Retained for compatibility with older settlement behaviour.
         *
         * Migration 008 routes verified amount/currency mismatches into
         * reconciliation_required.
         */
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
       * Paystack transaction IDs may exceed JavaScript's safe integer
       * range.
       *
       * Convert the first JSON id integer to a quoted string before
       * JSON.parse so it cannot be rounded.
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
  ) {
    if (
      !Number.isSafeInteger(
        value,
      ) ||
      (value ?? 0) <=
        0
    ) {
      throw new ServiceUnavailableException(
        'Paystack returned an invalid payment amount.',
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