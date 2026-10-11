import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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

export type TransferPayoutResult = {
  status:
    | 'processing'
    | 'verification_pending'
    | 'otp_required'
    | 'completed';
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
    const providerTransfer =
      await this.verifyProviderTransfer(
        prepared,
      );

    if (
      !providerTransfer
    ) {
      /*
       * Still uncertain.
       *
       * Never submit another POST /transfer here.
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
        this.logger.warn(
          `Paystack payout verification did not return a confirmed transfer for HTTP ${response.status}.`,
        );

        return null;
      }

      try {
        return this.readProviderTransfer(
          body.data,
          prepared,
        );
      } catch {
        this.logger.error(
          'Paystack payout verification returned transfer details that do not match MOVA.',
        );

        return null;
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

        return null;
      }

      this.logger.warn(
        'Unable to verify an existing Paystack payout right now.',
      );

      return null;
    } finally {
      clearTimeout(
        timeout,
      );
    }
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