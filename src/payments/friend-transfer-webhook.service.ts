import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../supabase/supabase.service';
import { TransferPayoutService } from '../transfers/transfer-payout.service';

type PaystackVerifyResponse = {
  status?: boolean;
  message?: string;

  data?: {
    id?: string | number;
    status?: string;
    reference?: string;
    amount?: number;
    requested_amount?: number;
    currency?: string;
    channel?: string;
    paid_at?: string | null;
  };
};

type SettlementResult = {
  status?: string;
  intentId?: string;
  quoteId?: string;
  payoutId?: string;
  reason?: string;
};

export type FriendTransferWebhookResult = {
  received: true;

  status:
    | 'transfer_payment_completed'
    | 'transfer_payment_already_completed'
    | 'transfer_payment_reconciliation_required'
    | 'ignored'
    | 'conflict'
    | 'invalid';
};

@Injectable()
export class FriendTransferWebhookService {
  private readonly logger =
    new Logger(
      FriendTransferWebhookService.name,
    );

  private readonly secretKey:
    string;

  constructor(
    private readonly config:
      ConfigService,

    private readonly supabase:
      SupabaseService,

    private readonly payouts:
      TransferPayoutService,
  ) {
    this.secretKey =
      this.config
        .get<string>(
          'PAYSTACK_SECRET_KEY',
        )
        ?.trim() ??
      '';
  }

  async handleChargeSuccess(
    reference:
      string,

    payloadHash:
      string,
  ): Promise<
    FriendTransferWebhookResult
  > {
    const cleanReference =
      reference
        .trim()
        .toLowerCase();

    if (
      !/^mova-ft-[0-9a-f]{32}$/.test(
        cleanReference,
      )
    ) {
      throw new BadRequestException(
        'Friend transfer payment reference is invalid.',
      );
    }

    if (
      !/^[0-9a-f]{64}$/.test(
        payloadHash,
      )
    ) {
      throw new BadRequestException(
        'Friend transfer webhook payload hash is invalid.',
      );
    }

    const verified =
      await this.verifyTransaction(
        cleanReference,
      );

    const verifiedStatus =
      verified.status
        ?.trim()
        .toLowerCase();

    if (
      verifiedStatus !==
        'success'
    ) {
      throw new ServiceUnavailableException(
        'The transfer payment is not yet verifiable as successful.',
      );
    }

    const verifiedReference =
      verified.reference
        ?.trim()
        .toLowerCase();

    if (
      verifiedReference !==
        cleanReference
    ) {
      throw new ServiceUnavailableException(
        'The verified transfer payment reference did not match the webhook.',
      );
    }

    const transactionId =
      this.safeTransactionId(
        verified.id,
      );

    const amountMinor =
      this.safeAmount(
        verified.amount,
        'payment amount',
      );

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

    if (
      channel !==
        'card'
    ) {
      throw new ServiceUnavailableException(
        'The verified transfer payment did not use the expected payment channel.',
      );
    }

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
        'complete_friend_transfer_payment_from_provider',
        {
          p_provider:
            'paystack',

          p_event_type:
            'charge.success',

          p_provider_reference:
            cleanReference,

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
        'Unable to persist verified friend-transfer payment settlement.',
      );

      throw new ServiceUnavailableException(
        'Unable to settle the verified transfer payment right now.',
      );
    }

    const result =
      data as
        SettlementResult;

    switch (
      result.status
    ) {
      case 'completed':
        await this.startRecipientPayout(
          result.payoutId,
        );

        return {
          received:
            true,

          status:
            'transfer_payment_completed',
        };

      case 'already_completed':
        /*
         * Retrying the payout here is safe.
         *
         * begin_friend_transfer_payout uses the same deterministic
         * reference and will verify an existing provider transfer rather
         * than submit a second payout.
         */
        await this.startRecipientPayout(
          result.payoutId,
        );

        return {
          received:
            true,

          status:
            'transfer_payment_already_completed',
        };

      case 'reconciliation_required':
        this.logger.warn(
          `Verified friend-transfer payment requires reconciliation${
            result.reason
              ? `: ${result.reason}`
              : '.'
          }`,
        );

        return {
          received:
            true,

          status:
            'transfer_payment_reconciliation_required',
        };

      case 'not_found':
        return {
          received:
            true,

          status:
            'ignored',
        };

      case 'conflict':
        this.logger.error(
          'Verified friend-transfer payment conflicts with existing settlement data.',
        );

        return {
          received:
            true,

          status:
            'conflict',
        };

      case 'invalid':
        this.logger.error(
          'Verified friend-transfer payment settlement was rejected as invalid.',
        );

        return {
          received:
            true,

          status:
            'invalid',
        };

      default:
        throw new ServiceUnavailableException(
          'Unable to determine the friend-transfer settlement state.',
        );
    }
  }

  private async startRecipientPayout(
    value:
      unknown,
  ) {
    const payoutId =
      this.requiredUuid(
        value,
      );

    const result =
      await this.payouts.initiate(
        payoutId,
      );

    if (
      result.status ===
        'verification_pending'
    ) {
      /*
       * Returning a temporary failure from the webhook is intentional.
       *
       * Paystack can retry charge.success. On that retry MOVA does NOT
       * create another payout; it verifies the existing deterministic
       * payout reference instead.
       */
      throw new ServiceUnavailableException(
        'The transfer payment was verified, but recipient payout confirmation is still pending.',
      );
    }

    if (
      result.status ===
        'otp_required'
    ) {
      this.logger.warn(
        'Friend-transfer payout requires Paystack transfer OTP confirmation.',
      );
    }
  }

  private async verifyTransaction(
    reference:
      string,
  ) {
    if (
      !this.isConfigured()
    ) {
      throw new ServiceUnavailableException(
        'Paystack transfer payment verification is not configured.',
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
          `Paystack friend-transfer transaction verification failed with HTTP ${response.status}.`,
        );

        throw new ServiceUnavailableException(
          'Transfer payment verification is temporarily unavailable.',
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
          'Transfer payment verification timed out.',
        );
      }

      this.logger.warn(
        'Unable to reach Paystack friend-transfer transaction verification.',
      );

      throw new ServiceUnavailableException(
        'Transfer payment verification is temporarily unavailable.',
      );
    } finally {
      clearTimeout(
        timeout,
      );
    }
  }

  private parseVerifyResponse(
    rawResponse:
      string,
  ):
    | PaystackVerifyResponse
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
        PaystackVerifyResponse;
    } catch {
      return null;
    }
  }

  private requiredUuid(
    value:
      unknown,
  ) {
    if (
      typeof value !==
        'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
      )
    ) {
      throw new ServiceUnavailableException(
        'The verified transfer payout could not be loaded safely.',
      );
    }

    return value;
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
      'Paystack returned an invalid transfer payment transaction ID.',
    );
  }

  private safeAmount(
    value:
      | number
      | undefined,

    label:
      string,
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

    return value as
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
        'Paystack returned an invalid transfer payment currency.',
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
        'Paystack returned an invalid transfer payment channel.',
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
        'Paystack returned an invalid transfer payment timestamp.',
      );
    }

    return new Date(
      value,
    ).toISOString();
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