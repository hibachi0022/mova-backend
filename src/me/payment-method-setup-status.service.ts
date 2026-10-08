import {
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

type DatabaseSetupStatus =
  | 'created'
  | 'checkout_ready'
  | 'completed'
  | 'failed'
  | 'expired';

export type PaymentMethodSetupRefundStatus =
  | 'not_requested'
  | 'initiating'
  | 'pending'
  | 'processing'
  | 'needs_attention'
  | 'processed'
  | 'failed';

export type PaymentMethodSetupStatusResponse =
  | {
      status:
        'none';
    }
  | {
      status:
        | 'awaiting_payment'
        | 'verified'
        | 'failed'
        | 'expired';

      refundStatus:
        PaymentMethodSetupRefundStatus;

      createdAt:
        string;

      completedAt?:
        string;

      refundRequestedAt?:
        string;

      refundedAt?:
        string;
    };

type PaymentMethodSetupRow = {
  status:
    string;

  refund_status:
    string;

  created_at:
    string;

  completed_at:
    | string
    | null;

  refund_requested_at:
    | string
    | null;

  refunded_at:
    | string
    | null;
};

@Injectable()
export class PaymentMethodSetupStatusService {
  constructor(
    private readonly supabase:
      SupabaseService,
  ) {}

  async getLatest(
    userId: string,
  ): Promise<
    PaymentMethodSetupStatusResponse
  > {
    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } =
      await admin
        .from(
          'payment_method_setups',
        )
        .select(
          'status, refund_status, created_at, completed_at, refund_requested_at, refunded_at',
        )
        .eq(
          'user_id',
          userId,
        )
        .order(
          'created_at',
          {
            ascending:
              false,
          },
        )
        .limit(
          1,
        )
        .maybeSingle();

    if (error) {
      throw new ServiceUnavailableException(
        'Unable to load card setup status right now.',
      );
    }

    if (!data) {
      return {
        status:
          'none',
      };
    }

    const row =
      data as
        PaymentMethodSetupRow;

    const setupStatus =
      this.safeSetupStatus(
        row.status,
      );

    const refundStatus =
      this.safeRefundStatus(
        row.refund_status,
      );

    const createdAt =
      this.requiredTimestamp(
        row.created_at,
        'card setup creation time',
      );

    const completedAt =
      this.optionalTimestamp(
        row.completed_at,
        'card setup completion time',
      );

    const refundRequestedAt =
      this.optionalTimestamp(
        row.refund_requested_at,
        'refund request time',
      );

    const refundedAt =
      this.optionalTimestamp(
        row.refunded_at,
        'refund completion time',
      );

    if (
      setupStatus ===
        'completed' &&
      !completedAt
    ) {
      throw new ServiceUnavailableException(
        'The completed card setup could not be loaded safely.',
      );
    }

    return {
      status:
        this.publicStatus(
          setupStatus,
        ),

      refundStatus,

      createdAt,

      ...(completedAt
        ? {
            completedAt,
          }
        : {}),

      ...(refundRequestedAt
        ? {
            refundRequestedAt,
          }
        : {}),

      ...(refundedAt
        ? {
            refundedAt,
          }
        : {}),
    };
  }

  private safeSetupStatus(
    value:
      string,
  ): DatabaseSetupStatus {
    switch (
      value
    ) {
      case 'created':
      case 'checkout_ready':
      case 'completed':
      case 'failed':
      case 'expired':
        return value;

      default:
        throw new ServiceUnavailableException(
          'The card setup status could not be loaded safely.',
        );
    }
  }

  private safeRefundStatus(
    value:
      string,
  ): PaymentMethodSetupRefundStatus {
    switch (
      value
    ) {
      case 'not_requested':
      case 'initiating':
      case 'pending':
      case 'processing':
      case 'needs_attention':
      case 'processed':
      case 'failed':
        return value;

      default:
        throw new ServiceUnavailableException(
          'The card verification refund status could not be loaded safely.',
        );
    }
  }

  private publicStatus(
    value:
      DatabaseSetupStatus,
  ):
    | 'awaiting_payment'
    | 'verified'
    | 'failed'
    | 'expired' {
    switch (
      value
    ) {
      case 'created':
      case 'checkout_ready':
        return 'awaiting_payment';

      case 'completed':
        return 'verified';

      case 'failed':
        return 'failed';

      case 'expired':
        return 'expired';
    }
  }

  private requiredTimestamp(
    value:
      string,

    label:
      string,
  ) {
    if (
      !Number.isFinite(
        Date.parse(
          value,
        ),
      )
    ) {
      throw new ServiceUnavailableException(
        `The ${label} could not be loaded safely.`,
      );
    }

    return new Date(
      value,
    ).toISOString();
  }

  private optionalTimestamp(
    value:
      | string
      | null,

    label:
      string,
  ) {
    if (!value) {
      return undefined;
    }

    if (
      !Number.isFinite(
        Date.parse(
          value,
        ),
      )
    ) {
      throw new ServiceUnavailableException(
        `The ${label} could not be loaded safely.`,
      );
    }

    return new Date(
      value,
    ).toISOString();
  }
}