import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../supabase/supabase.service';

type PaystackTransferVerifyResponse = {
  status?:
    boolean;

  message?:
    string;

  data?: {
    id?:
      | string
      | number;

    amount?:
      number;

    currency?:
      string;

    reference?:
      string;

    status?:
      string;

    transfer_code?:
      string;
  };
};

type VerifiedTransfer = {
  reference:
    string;

  transferCode:
    string;

  transferId:
    string;

  amountMinor:
    number;

  currency:
    'NGN';

  status:
    | 'success'
    | 'failed'
    | 'reversed';
};

type PayoutSettlementResult = {
  status?:
    string;

  payoutStatus?:
    string;

  previousPayoutStatus?:
    string;

  payoutId?:
    string;

  reason?:
    string;
};

export type FriendTransferPayoutWebhookResult = {
  received:
    true;

  status:
    | 'transfer_payout_completed'
    | 'transfer_payout_failed'
    | 'transfer_payout_reversed'
    | 'transfer_payout_already_finalized'
    | 'transfer_payout_reconciliation_required'
    | 'ignored'
    | 'conflict'
    | 'invalid';
};

@Injectable()
export class FriendTransferPayoutWebhookService {
  private readonly logger =
    new Logger(
      FriendTransferPayoutWebhookService.name,
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

  isTransferEvent(
    event:
      string,
  ) {
    return (
      event ===
        'transfer.success' ||
      event ===
        'transfer.failed' ||
      event ===
        'transfer.reversed'
    );
  }

  async handleTransferEvent(
    eventType:
      string,

    data:
      unknown,

    payloadHash:
      string,
  ): Promise<
    FriendTransferPayoutWebhookResult
  > {
    if (
      !this.isTransferEvent(
        eventType,
      )
    ) {
      return {
        received:
          true,

        status:
          'ignored',
      };
    }

    if (
      !/^[0-9a-f]{64}$/.test(
        payloadHash,
      )
    ) {
      throw new BadRequestException(
        'Friend transfer payout webhook payload hash is invalid.',
      );
    }

    const reference =
      this.extractReference(
        data,
      );

    /*
     * The same Paystack account may later have transfers unrelated to
     * MOVA friend transfers.
     *
     * A valid signed Paystack event with some other reference should
     * simply be acknowledged and ignored.
     */
    if (
      !reference ||
      !reference.startsWith(
        'mova-po-',
      )
    ) {
      return {
        received:
          true,

        status:
          'ignored',
      };
    }

    if (
      !/^mova-po-[0-9a-f]{32}$/.test(
        reference,
      )
    ) {
      throw new BadRequestException(
        'Friend transfer payout reference is invalid.',
      );
    }

    const verified =
      await this.verifyTransfer(
        reference,
      );

    const expectedStatus =
      this.expectedProviderStatus(
        eventType,
      );

    if (
      verified.status !==
        expectedStatus
    ) {
      /*
       * The signed webhook and independent Verify Transfer response
       * disagree.
       *
       * Never use the webhook body itself as financial truth.
       */
      throw new ServiceUnavailableException(
        'The verified payout status did not match the Paystack webhook event.',
      );
    }

    const admin =
      this.supabase.createAdminClient();

    const {
      data:
        settlementData,
      error:
        settlementError,
    } =
      await admin.rpc(
        'complete_friend_transfer_payout_from_provider',
        {
          p_provider:
            'paystack',

          p_event_type:
            eventType,

          p_provider_reference:
            verified.reference,

          p_provider_transfer_code:
            verified.transferCode,

          p_provider_transfer_id:
            verified.transferId,

          p_amount_minor:
            verified.amountMinor,

          p_currency:
            verified.currency,

          p_provider_status:
            verified.status,

          p_payload_hash:
            payloadHash,
        },
      );

    if (
      settlementError ||
      !settlementData
    ) {
      this.logger.error(
        'Unable to persist independently verified friend-transfer payout settlement.',
      );

      throw new ServiceUnavailableException(
        'Unable to settle the verified recipient payout right now.',
      );
    }

    const result =
      settlementData as
        PayoutSettlementResult;

    switch (
      result.status
    ) {
      case 'finalized':
        return this.finalizedResult(
          result,
          verified.status,
        );

      case 'already_finalized':
        return {
          received:
            true,

          status:
            'transfer_payout_already_finalized',
        };

      case 'reconciliation_required':
        this.logger.warn(
          `Verified friend-transfer payout requires reconciliation${
            result.reason
              ? `: ${result.reason}`
              : '.'
          }`,
        );

        return {
          received:
            true,

          status:
            'transfer_payout_reconciliation_required',
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
          'Verified friend-transfer payout conflicts with existing MOVA payout state.',
        );

        return {
          received:
            true,

          status:
            'conflict',
        };

      case 'invalid':
        this.logger.error(
          'Verified friend-transfer payout was rejected as invalid by the database.',
        );

        return {
          received:
            true,

          status:
            'invalid',
        };

      default:
        throw new ServiceUnavailableException(
          'Unable to determine the friend-transfer payout settlement state.',
        );
    }
  }

  private finalizedResult(
    result:
      PayoutSettlementResult,

    verifiedStatus:
      VerifiedTransfer['status'],
  ): FriendTransferPayoutWebhookResult {
    const storedStatus =
      result.payoutStatus
        ?.trim()
        .toLowerCase();

    if (
      storedStatus !==
        verifiedStatus
    ) {
      throw new ServiceUnavailableException(
        'The stored payout settlement did not match the verified provider state.',
      );
    }

    switch (
      verifiedStatus
    ) {
      case 'success':
        return {
          received:
            true,

          status:
            'transfer_payout_completed',
        };

      case 'failed':
        return {
          received:
            true,

          status:
            'transfer_payout_failed',
        };

      case 'reversed':
        return {
          received:
            true,

          status:
            'transfer_payout_reversed',
        };
    }
  }

  private extractReference(
    value:
      unknown,
  ) {
    if (
      !value ||
      typeof value !==
        'object' ||
      Array.isArray(
        value,
      )
    ) {
      return null;
    }

    const reference =
      (
        value as
          Record<
            string,
            unknown
          >
      ).reference;

    if (
      typeof reference !==
        'string'
    ) {
      return null;
    }

    const cleaned =
      reference
        .trim()
        .toLowerCase();

    return cleaned ||
      null;
  }

  private expectedProviderStatus(
    eventType:
      string,
  ):
    VerifiedTransfer['status'] {
    switch (
      eventType
    ) {
      case 'transfer.success':
        return 'success';

      case 'transfer.failed':
        return 'failed';

      case 'transfer.reversed':
        return 'reversed';

      default:
        throw new BadRequestException(
          'Unsupported Paystack transfer event.',
        );
    }
  }

  private async verifyTransfer(
    reference:
      string,
  ): Promise<
    VerifiedTransfer
  > {
    if (
      !this.isConfigured()
    ) {
      throw new ServiceUnavailableException(
        'Paystack payout verification is not configured.',
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
          `https://api.paystack.co/transfer/verify/${encodeURIComponent(
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
        this.parseProviderResponse(
          rawResponse,
        );

      if (
        !response.ok ||
        body?.status !==
          true ||
        !body.data
      ) {
        this.logger.warn(
          `Paystack friend-transfer payout verification failed with HTTP ${response.status}.`,
        );

        throw new ServiceUnavailableException(
          'Recipient payout verification is temporarily unavailable.',
        );
      }

      return this.readVerifiedTransfer(
        body.data,
        reference,
      );
    } catch (
      error:
        unknown
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
          'Recipient payout verification timed out.',
        );
      }

      this.logger.warn(
        'Unable to reach Paystack recipient payout verification.',
      );

      throw new ServiceUnavailableException(
        'Recipient payout verification is temporarily unavailable.',
      );
    } finally {
      clearTimeout(
        timeout,
      );
    }
  }

  private readVerifiedTransfer(
    data:
      NonNullable<
        PaystackTransferVerifyResponse['data']
      >,

    expectedReference:
      string,
  ): VerifiedTransfer {
    const reference =
      data.reference
        ?.trim()
        .toLowerCase();

    if (
      reference !==
        expectedReference
    ) {
      throw new ServiceUnavailableException(
        'The verified payout reference did not match the webhook.',
      );
    }

    const amountMinor =
      data.amount;

    if (
      !Number.isSafeInteger(
        amountMinor,
      ) ||
      (amountMinor ?? 0) <=
        0
    ) {
      throw new ServiceUnavailableException(
        'Paystack returned an invalid payout amount.',
      );
    }

    const currency =
      data.currency
        ?.trim()
        .toUpperCase();

    if (
      currency !==
        'NGN'
    ) {
      throw new ServiceUnavailableException(
        'Paystack returned an invalid payout currency.',
      );
    }

    const transferCode =
      data.transfer_code
        ?.trim() ??
      '';

    if (
      transferCode.length <
        3 ||
      transferCode.length >
        100
    ) {
      throw new ServiceUnavailableException(
        'Paystack returned an invalid payout transfer code.',
      );
    }

    const transferId =
      this.safeProviderId(
        data.id,
      );

    const status =
      data.status
        ?.trim()
        .toLowerCase();

    if (
      status !==
        'success' &&
      status !==
        'failed' &&
      status !==
        'reversed'
    ) {
      /*
       * These webhook handlers process only conclusive transfer events.
       *
       * pending / otp / blocked / etc. must not be finalized here.
       */
      throw new ServiceUnavailableException(
        'Paystack payout verification has not reached a conclusive state.',
      );
    }

    return {
      reference,

      amountMinor:
        amountMinor as
          number,

      currency:
        'NGN',

      transferCode,

      transferId,

      status,
    };
  }

  private safeProviderId(
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
      'Paystack returned an invalid payout transfer ID.',
    );
  }

  private parseProviderResponse(
    rawResponse:
      string,
  ):
    | PaystackTransferVerifyResponse
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
        PaystackTransferVerifyResponse;
    } catch {
      return null;
    }
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