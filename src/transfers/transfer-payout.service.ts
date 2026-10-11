import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { SupabaseService } from '../supabase/supabase.service';

type BeginPayoutResult = {
  status?: string;
  payoutId?: string;
  amountMinor?: number | string;
  currency?: string;
  providerReference?: string;
  providerRecipientCode?: string;
};

type RecordPayoutResult = {
  status?: string;
  payoutId?: string;
  payoutStatus?: string;
  providerStatus?: string;
};

type PayoutSettlementResult = {
  status?: string;
  payoutStatus?: string;
  payoutId?: string;
  reason?: string;
};

type PaystackTransferResponse = {
  status?: boolean;
  message?: string;

  data?: {
    id?: string | number;
    amount?: number;
    currency?: string;
    reference?: string;
    status?: string;
    transfer_code?: string;
  };
};

type PreparedPayout = {
  payoutId: string;
  amountMinor: number;
  currency: 'NGN';
  providerReference: string;
  providerRecipientCode: string;
};

type ProviderTransfer = {
  reference: string;
  amountMinor: number;
  currency: 'NGN';
  transferCode: string;
  transferId: string;

  status:
    | 'pending'
    | 'success'
    | 'failed'
    | 'reversed'
    | 'otp'
    | 'blocked'
    | 'abandoned'
    | 'rejected';
};

type ProviderTransferVerification =
  | {
      kind:
        'found';

      transfer:
        ProviderTransfer;
    }
  | {
      kind:
        'not_found';
    }
  | {
      kind:
        'uncertain';
    };

type PayoutOwnershipRow = {
  id:
    string;

  payment_intent_id:
    string;

  sender_user_id:
    string;

  recipient_user_id:
    string;

  status:
    string;
};

export type TransferPayoutResult = {
  status:
    | 'processing'
    | 'verification_pending'
    | 'otp_required'
    | 'completed'
    | 'failed'
    | 'reversed'
    | 'reconciliation_required';
};

@Injectable()
export class TransferPayoutService {
  private readonly logger =
    new Logger(
      TransferPayoutService.name,
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

  async reconcileForUser(
    userId:
      string,

    paymentIntentId:
      string,
  ): Promise<
    TransferPayoutResult
  > {
    const cleanUserId =
      this.requiredUuid(
        userId,
        'user',
      );

    const cleanPaymentIntentId =
      this.requiredUuid(
        paymentIntentId,
        'transfer payment',
      );

    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } =
      await admin
        .from(
          'friend_transfer_payouts',
        )
        .select(
          'id, payment_intent_id, sender_user_id, recipient_user_id, status',
        )
        .eq(
          'payment_intent_id',
          cleanPaymentIntentId,
        )
        .maybeSingle();

    if (error) {
      throw new ServiceUnavailableException(
        'Unable to load the transfer payout right now.',
      );
    }

    if (!data) {
      throw new NotFoundException(
        'Transfer payout not found.',
      );
    }

    const row =
      data as
        PayoutOwnershipRow;

    if (
      row.payment_intent_id !==
        cleanPaymentIntentId ||
      (
        row.sender_user_id !==
          cleanUserId &&
        row.recipient_user_id !==
          cleanUserId
      )
    ) {
      throw new NotFoundException(
        'Transfer payout not found.',
      );
    }

    const payoutId =
      this.requiredUuid(
        row.id,
        'payout',
      );

    switch (
      row.status
    ) {
      case 'success':
        return {
          status:
            'completed',
        };

      case 'failed':
      case 'blocked':
      case 'abandoned':
      case 'rejected':
        return {
          status:
            'failed',
        };

      case 'reversed':
        return {
          status:
            'reversed',
        };

      case 'reconciliation_required':
        return {
          status:
            'reconciliation_required',
        };

      case 'created':
      case 'initiating':
      case 'pending':
      case 'otp_required':
        return this.initiate(
          payoutId,
        );

      default:
        throw new ServiceUnavailableException(
          'Unable to determine the transfer payout state.',
        );
    }
  }

  async initiate(
    payoutId:
      string,
  ): Promise<
    TransferPayoutResult
  > {
    if (
      !this.isConfigured()
    ) {
      throw new ServiceUnavailableException(
        'Paystack transfers are not configured.',
      );
    }

    const providerReference =
      this.providerReference(
        payoutId,
      );

    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } =
      await admin.rpc(
        'begin_friend_transfer_payout',
        {
          p_payout_id:
            payoutId,

          p_provider_reference:
            providerReference,
        },
      );

    if (
      error ||
      !data
    ) {
      throw new ServiceUnavailableException(
        'Unable to prepare the recipient payout right now.',
      );
    }

    const begin =
      data as
        BeginPayoutResult;

    switch (
      begin.status
    ) {
      case 'ready':
        break;

      case 'existing': {
        const prepared =
          this.readPreparedPayout(
            begin,
            payoutId,
            providerReference,
          );

        return this.reconcileExisting(
          prepared,
        );
      }

      case 'already_completed':
        return {
          status:
            'completed',
        };

      case 'not_found':
        throw new NotFoundException(
          'Transfer payout not found.',
        );

      case 'recipient_account_not_found':
        throw new ConflictException(
          'The recipient receiving account could not be loaded.',
        );

      case 'recipient_account_mismatch':
        throw new ConflictException(
          'The recipient receiving account no longer matches this payout.',
        );

      case 'conflict':
        throw new ConflictException(
          'This payout conflicts with an existing transfer attempt.',
        );

      case 'not_available':
        throw new ConflictException(
          'This payout is no longer available for initiation.',
        );

      case 'invalid':
        throw new BadRequestException(
          'Unable to prepare this payout request.',
        );

      default:
        throw new ServiceUnavailableException(
          'Unable to determine the recipient payout state.',
        );
    }

    const prepared =
      this.readPreparedPayout(
        begin,
        payoutId,
        providerReference,
      );

    const providerTransfer =
      await this.initiateProviderTransfer(
        prepared,
      );

    if (
      !providerTransfer
    ) {
      /*
       * The POST /transfer result was uncertain.
       *
       * We must not POST again automatically. The next retry goes through
       * begin_friend_transfer_payout -> existing -> Verify Transfer using
       * this same deterministic reference.
       */
      return {
        status:
          'verification_pending',
      };
    }

    return this.recordProviderTransfer(
      prepared,
      providerTransfer,
    );
  }

  private async reconcileExisting(
    prepared:
      PreparedPayout,
  ): Promise<
    TransferPayoutResult
  > {
    const verification =
      await this.verifyProviderTransfer(
        prepared,
      );

    if (
      verification.kind ===
      'found'
    ) {
      if (
        this.isTerminalProviderStatus(
          verification.transfer.status,
        )
      ) {
        return this.finalizeVerifiedProviderTransfer(
          prepared,
          verification.transfer,
        );
      }

      return this.recordProviderTransfer(
        prepared,
        verification.transfer,
      );
    }

    if (
      verification.kind ===
      'uncertain'
    ) {
      return {
        status:
          'verification_pending',
      };
    }

    /*
     * Paystack has definitively reported that no transfer exists for
     * MOVA's deterministic provider reference.
     *
     * Retrying with the exact same reference is safe and is required
     * for recovery. We never generate a second provider reference for
     * the same MOVA payout.
     */
    this.logger.warn(
      'Paystack reported the existing payout reference as not found; retrying the transfer with the same reference.',
    );

    const retry =
      await this.initiateProviderTransfer(
        prepared,
      );

    if (!retry) {
      return {
        status:
          'verification_pending',
      };
    }

    return this.recordProviderTransfer(
      prepared,
      retry,
    );
  }

  private async initiateProviderTransfer(
    prepared:
      PreparedPayout,
  ): Promise<
    ProviderTransfer | null
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
          'https://api.paystack.co/transfer',
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
                source:
                  'balance',

                amount:
                  prepared.amountMinor,

                recipient:
                  prepared.providerRecipientCode,

                reference:
                  prepared.providerReference,

                reason:
                  'MOVA friend transfer',

                currency:
                  prepared.currency,
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
        !body.data
      ) {
        this.logger.warn(
          `Paystack payout initiation returned an uncertain HTTP ${response.status} response.`,
        );

        return null;
      }

      return this.readProviderTransfer(
        body.data,
        prepared,
      );
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
        this.logger.warn(
          'Paystack payout initiation timed out; payout remains initiating.',
        );

        return null;
      }

      this.logger.warn(
        'Paystack payout initiation response was uncertain; payout remains initiating.',
      );

      return null;
    } finally {
      clearTimeout(
        timeout,
      );
    }
  }

  private async verifyProviderTransfer(
    prepared:
      PreparedPayout,
  ): Promise<
    ProviderTransferVerification
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
          `https://api.paystack.co/transfer/verify/${encodeURIComponent(
            prepared.providerReference,
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
        if (
          this.isDefinitiveTransferNotFound(
            response.status,
            body?.message,
          )
        ) {
          return {
            kind:
              'not_found',
          };
        }

        this.logger.warn(
          `Paystack payout verification did not return a confirmed transfer for HTTP ${response.status}.`,
        );

        return {
          kind:
            'uncertain',
        };
      }

      try {
        return {
          kind:
            'found',

          transfer:
            this.readProviderTransfer(
              body.data,
              prepared,
            ),
        };
      } catch {
        this.logger.error(
          'Paystack payout verification returned transfer details that do not match MOVA.',
        );

        return {
          kind:
            'uncertain',
        };
      }
    } catch (
      error: unknown
    ) {
      if (
        error instanceof
          Error &&
        error.name ===
          'AbortError'
      ) {
        this.logger.warn(
          'Paystack payout verification timed out.',
        );

        return {
          kind:
            'uncertain',
        };
      }

      this.logger.warn(
        'Unable to verify an existing Paystack payout right now.',
      );

      return {
        kind:
          'uncertain',
      };
    } finally {
      clearTimeout(
        timeout,
      );
    }
  }

  private async finalizeVerifiedProviderTransfer(
    prepared:
      PreparedPayout,

    transfer:
      ProviderTransfer & {
        status:
          | 'success'
          | 'failed'
          | 'reversed';
      },
  ): Promise<
    TransferPayoutResult
  > {
    const eventType =
      `transfer.${transfer.status}`;

    const payloadHash =
      createHash(
        'sha256',
      )
        .update(
          [
            'mova-payout-reconcile-v1',
            transfer.reference,
            transfer.transferCode,
            transfer.transferId,
            String(
              transfer.amountMinor,
            ),
            transfer.currency,
            transfer.status,
          ].join(
            '|',
          ),
          'utf8',
        )
        .digest(
          'hex',
        );

    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } =
      await admin.rpc(
        'complete_friend_transfer_payout_from_provider',
        {
          p_provider:
            'paystack',

          p_event_type:
            eventType,

          p_provider_reference:
            prepared.providerReference,

          p_provider_transfer_code:
            transfer.transferCode,

          p_provider_transfer_id:
            transfer.transferId,

          p_amount_minor:
            transfer.amountMinor,

          p_currency:
            transfer.currency,

          p_provider_status:
            transfer.status,

          p_payload_hash:
            payloadHash,
        },
      );

    if (
      error ||
      !data
    ) {
      throw new ServiceUnavailableException(
        'The payout was verified but MOVA could not finalize it safely.',
      );
    }

    const result =
      data as
        PayoutSettlementResult;

    switch (
      result.status
    ) {
      case 'finalized':
      case 'already_finalized':
        return this.terminalPayoutResult(
          result.payoutStatus ??
            transfer.status,
        );

      case 'reconciliation_required':
        this.logger.warn(
          `Verified payout requires reconciliation${
            result.reason
              ? `: ${result.reason}`
              : '.'
          }`,
        );

        return {
          status:
            'reconciliation_required',
        };

      case 'not_found':
        throw new NotFoundException(
          'Transfer payout not found.',
        );

      case 'conflict':
        throw new ConflictException(
          'The verified provider payout conflicts with the stored MOVA payout.',
        );

      case 'invalid':
        throw new BadRequestException(
          'The verified provider payout could not be finalized safely.',
        );

      default:
        throw new ServiceUnavailableException(
          'Unable to determine the verified payout settlement state.',
        );
    }
  }

  private terminalPayoutResult(
    status:
      string,
  ): TransferPayoutResult {
    switch (
      status
    ) {
      case 'success':
        return {
          status:
            'completed',
        };

      case 'failed':
        return {
          status:
            'failed',
        };

      case 'reversed':
        return {
          status:
            'reversed',
        };

      default:
        throw new ServiceUnavailableException(
          'The finalized payout status could not be loaded safely.',
        );
    }
  }

  private isTerminalProviderStatus(
    status:
      ProviderTransfer['status'],
  ): status is
    | 'success'
    | 'failed'
    | 'reversed' {
    return (
      status ===
        'success' ||
      status ===
        'failed' ||
      status ===
        'reversed'
    );
  }

  private async recordProviderTransfer(
    prepared:
      PreparedPayout,

    transfer:
      ProviderTransfer,
  ): Promise<
    TransferPayoutResult
  > {
    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } =
      await admin.rpc(
        'record_friend_transfer_payout_initiation',
        {
          p_payout_id:
            prepared.payoutId,

          p_provider_reference:
            prepared.providerReference,

          p_provider_transfer_code:
            transfer.transferCode,

          p_provider_transfer_id:
            transfer.transferId,

          p_provider_status:
            transfer.status,
        },
      );

    if (
      error ||
      !data
    ) {
      throw new ServiceUnavailableException(
        'The payout was submitted but MOVA could not record the provider transfer safely.',
      );
    }

    const result =
      data as
        RecordPayoutResult;

    switch (
      result.status
    ) {
      case 'recorded':
        if (
          result.payoutStatus ===
            'otp_required' ||
          transfer.status ===
            'otp'
        ) {
          return {
            status:
              'otp_required',
          };
        }

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
          'Transfer payout not found.',
        );

      case 'conflict':
        throw new ConflictException(
          'The provider transfer conflicts with the stored MOVA payout.',
        );

      case 'not_available':
        throw new ConflictException(
          'This payout can no longer accept provider transfer details.',
        );

      case 'invalid':
        throw new BadRequestException(
          'The provider transfer could not be recorded safely.',
        );

      default:
        throw new ServiceUnavailableException(
          'Unable to determine the provider payout state.',
        );
    }
  }

  private readPreparedPayout(
    result:
      BeginPayoutResult,

    expectedPayoutId:
      string,

    expectedReference:
      string,
  ): PreparedPayout {
    const payoutId =
      this.requiredUuid(
        result.payoutId,
        'payout',
      );

    if (
      payoutId !==
        expectedPayoutId
    ) {
      throw new ServiceUnavailableException(
        'The prepared payout did not match the requested payout.',
      );
    }

    const amountMinor =
      this.safeMinorAmount(
        result.amountMinor,
      );

    const currency =
      result.currency
        ?.trim()
        .toUpperCase();

    if (
      currency !==
        'NGN'
    ) {
      throw new ServiceUnavailableException(
        'The payout currency could not be loaded safely.',
      );
    }

    const providerReference =
      result.providerReference
        ?.trim()
        .toLowerCase();

    if (
      providerReference !==
        expectedReference
    ) {
      throw new ServiceUnavailableException(
        'The payout provider reference could not be loaded safely.',
      );
    }

    const providerRecipientCode =
      result.providerRecipientCode
        ?.trim() ??
      '';

    if (
      !/^RCP_[A-Za-z0-9_-]{1,196}$/.test(
        providerRecipientCode,
      )
    ) {
      throw new ServiceUnavailableException(
        'The payout recipient could not be loaded safely.',
      );
    }

    return {
      payoutId,

      amountMinor,

      currency:
        'NGN',

      providerReference,

      providerRecipientCode,
    };
  }

  private readProviderTransfer(
    data:
      NonNullable<
        PaystackTransferResponse['data']
      >,

    expected:
      PreparedPayout,
  ): ProviderTransfer {
    const reference =
      data.reference
        ?.trim()
        .toLowerCase();

    if (
      reference !==
        expected.providerReference
    ) {
      throw new ServiceUnavailableException(
        'Paystack returned an unexpected payout reference.',
      );
    }

    if (
      !Number.isSafeInteger(
        data.amount,
      ) ||
      data.amount !==
        expected.amountMinor
    ) {
      throw new ServiceUnavailableException(
        'Paystack returned an unexpected payout amount.',
      );
    }

    const currency =
      data.currency
        ?.trim()
        .toUpperCase();

    if (
      currency !==
        expected.currency
    ) {
      throw new ServiceUnavailableException(
        'Paystack returned an unexpected payout currency.',
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
        'Paystack returned an invalid transfer code.',
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
        'pending' &&
      status !==
        'success' &&
      status !==
        'failed' &&
      status !==
        'reversed' &&
      status !==
        'otp' &&
      status !==
        'blocked' &&
      status !==
        'abandoned' &&
      status !==
        'rejected'
    ) {
      throw new ServiceUnavailableException(
        'Paystack returned an invalid payout status.',
      );
    }

    return {
      reference,

      amountMinor:
        data.amount,

      currency:
        'NGN',

      transferCode,

      transferId,

      status,
    };
  }

  private isDefinitiveTransferNotFound(
    status:
      number,

    message:
      unknown,
  ) {
    if (
      status !==
        404 ||
      typeof message !==
        'string'
    ) {
      return false;
    }

    const cleaned =
      message
        .trim()
        .toLowerCase();

    return (
      cleaned.includes(
        'transfer',
      ) &&
      cleaned.includes(
        'not found',
      )
    );
  }

  private parseProviderResponse(
    rawResponse:
      string,
  ):
    | PaystackTransferResponse
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
        PaystackTransferResponse;
    } catch {
      return null;
    }
  }

  private providerReference(
    payoutId:
      string,
  ) {
    const cleanId =
      this.requiredUuid(
        payoutId,
        'payout',
      );

    return `mova-po-${cleanId
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
        'The payout amount could not be loaded safely.',
      );
    }

    return amount as
      number;
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
      'Paystack returned an invalid transfer ID.',
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