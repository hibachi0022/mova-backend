import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { OutingsService } from './outings.service';

const PAYMENT_RECEIPT_SELECT =
  'id, outing_id, selected_member_id, payer_user_id, amount_minor, currency, method_id, provider, provider_reference, provider_transaction_id, provider_amount_minor, provider_requested_amount_minor, provider_currency, provider_channel, provider_paid_at, provider_verified_at, completed_at, status, reconciliation_state, reconciliation_resolution' as const;

type CompletedPaymentRow = {
  id: string;

  outing_id: string;

  selected_member_id:
    | string
    | null;

  payer_user_id:
    | string
    | null;

  amount_minor:
    | number
    | string;

  currency: string;

  method_id: string;

  provider:
    | string
    | null;

  provider_reference:
    | string
    | null;

  provider_transaction_id:
    | string
    | null;

  provider_amount_minor:
    | number
    | string
    | null;

  provider_requested_amount_minor:
    | number
    | string
    | null;

  provider_currency:
    | string
    | null;

  provider_channel:
    | string
    | null;

  provider_paid_at:
    | string
    | null;

  provider_verified_at:
    | string
    | null;

  completed_at:
    | string
    | null;

  status: string;

  reconciliation_state:
    string;

  reconciliation_resolution:
    | string
    | null;
};

export type OutingPaymentReceiptResponse = {
  receiptId: string;

  outing: {
    id: string;
    title: string;
    location: string;
  };

  status:
    'completed';

  payer: {
    memberId:
      | string
      | null;

    displayName:
      string | null;
  };

  requestedAmountMinor: number;

  chargedAmountMinor: number;

  feeAmountMinor: number;

  currency: string;

  methodId: string;

  provider: string;

  providerReference: string;

  providerTransactionId:
    string | null;

  providerChannel:
    string | null;

  paidAt: string;

  verifiedAt:
    | string
    | null;

  reconciliation: {
    state: string;

    resolution:
      | string
      | null;
  };
};

@Injectable()
export class OutingsPaymentReceiptsService {
  constructor(
    private readonly supabase:
      SupabaseService,

    private readonly outings:
      OutingsService,
  ) {}

  async getReceipt(
    userId: string,
    outingId: string,
  ): Promise<
    OutingPaymentReceiptResponse
  > {
    /*
     * OutingsService.get verifies that the caller is an active
     * registered member before any receipt data is exposed.
     */
    const outing =
      await this.outings.get(
        userId,
        outingId,
      );

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
          PAYMENT_RECEIPT_SELECT,
        )
        .eq(
          'outing_id',
          outingId,
        )
        .eq(
          'status',
          'completed',
        )
        .maybeSingle();

    if (
      error
    ) {
      throw new ServiceUnavailableException(
        'Unable to load the payment receipt right now.',
      );
    }

    if (
      !data
    ) {
      throw new NotFoundException(
        'A completed payment receipt is not available for this outing.',
      );
    }

    const payment:
      CompletedPaymentRow =
      data;

    const requestedAmountMinor =
      this.safeMinorAmount(
        payment
          .provider_requested_amount_minor ??
          payment.amount_minor,
        'requested amount',
      );

    const chargedAmountMinor =
      this.safeMinorAmount(
        payment
          .provider_amount_minor ??
          payment.amount_minor,
        'charged amount',
      );

    const currency =
      (
        payment.provider_currency ??
        payment.currency
      )
        .trim()
        .toUpperCase();

    if (
      !/^[A-Z]{3}$/.test(
        currency,
      )
    ) {
      throw new ServiceUnavailableException(
        'The receipt currency could not be loaded safely.',
      );
    }

    const paidAt =
      payment.provider_paid_at ??
      payment.completed_at;

    if (
      !paidAt ||
      !Number.isFinite(
        Date.parse(
          paidAt,
        ),
      )
    ) {
      throw new ServiceUnavailableException(
        'The receipt payment date could not be loaded safely.',
      );
    }

    let verifiedAt:
      | string
      | null =
      null;

    if (
      payment.provider_verified_at
    ) {
      if (
        !Number.isFinite(
          Date.parse(
            payment.provider_verified_at,
          ),
        )
      ) {
        throw new ServiceUnavailableException(
          'The receipt verification date could not be loaded safely.',
        );
      }

      verifiedAt =
        new Date(
          payment.provider_verified_at,
        ).toISOString();
    }

    if (
      !payment.provider ||
      !payment.provider_reference
    ) {
      throw new ServiceUnavailableException(
        'The completed payment provider details are incomplete.',
      );
    }

    const payer =
      payment.selected_member_id
        ? outing.members.find(
            (
              member,
            ) =>
              member.id ===
              payment.selected_member_id,
          )
        : undefined;

    const feeAmountMinor =
      Math.max(
        0,
        chargedAmountMinor -
          requestedAmountMinor,
      );

    return {
      receiptId:
        payment.id,

      outing: {
        id:
          outing.id,

        title:
          outing.title,

        location:
          outing.location,
      },

      status:
        'completed',

      payer: {
        memberId:
          payment.selected_member_id,

        displayName:
          payer?.displayName ??
          null,
      },

      requestedAmountMinor,

      chargedAmountMinor,

      feeAmountMinor,

      currency,

      methodId:
        payment.method_id,

      provider:
        payment.provider,

      providerReference:
        payment.provider_reference,

      providerTransactionId:
        payment.provider_transaction_id,

      providerChannel:
        payment.provider_channel,

      paidAt:
        new Date(
          paidAt,
        ).toISOString(),

      verifiedAt,

      reconciliation: {
        state:
          payment.reconciliation_state,

        resolution:
          payment.reconciliation_resolution,
      },
    };
  }

  private safeMinorAmount(
    value:
      | number
      | string
      | null
      | undefined,

    label: string,
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
        `The receipt ${label} could not be loaded safely.`,
      );
    }

    return amount as number;
  }
}