import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

const PAYMENT_METHOD_SELECT =
  'id, network, last4, is_default, created_at' as const;

type PaymentMethodRow = {
  id: string;
  network: string;
  last4: string;
  is_default: boolean;
  created_at: string;
};

type PaymentMethodManagementResult = {
  status?: string;

  paymentMethodId?: string;

  replacementDefaultId?:
    | string
    | null;
};

export type SavedPaymentMethod = {
  id: string;
  network: string;
  last4: string;
  isDefault: boolean;
};

@Injectable()
export class PaymentMethodsService {
  constructor(
    private readonly supabase:
      SupabaseService,
  ) {}

  async list(
    userId: string,
  ): Promise<{
    methods:
      SavedPaymentMethod[];
  }> {
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
          PAYMENT_METHOD_SELECT,
        )
        .eq(
          'user_id',
          userId,
        )
        .is(
          'disabled_at',
          null,
        );

    if (error) {
      throw new ServiceUnavailableException(
        'Unable to load saved payment methods right now.',
      );
    }

    const rows =
      (
        data ??
        []
      ) as
        PaymentMethodRow[];

    const methods =
      rows.map(
        (
          row,
        ): SavedPaymentMethod & {
          createdAt: string;
        } => {
          const network =
            row.network
              ?.trim()
              .toLowerCase() ??
            '';

          if (
            network.length <
              1 ||
            network.length >
              40
          ) {
            throw new ServiceUnavailableException(
              'A saved payment method could not be loaded safely.',
            );
          }

          if (
            !/^[0-9]{4}$/.test(
              row.last4,
            )
          ) {
            throw new ServiceUnavailableException(
              'A saved payment method could not be loaded safely.',
            );
          }

          if (
            typeof row.is_default !==
            'boolean'
          ) {
            throw new ServiceUnavailableException(
              'A saved payment method could not be loaded safely.',
            );
          }

          if (
            !Number.isFinite(
              Date.parse(
                row.created_at,
              ),
            )
          ) {
            throw new ServiceUnavailableException(
              'A saved payment method could not be loaded safely.',
            );
          }

          return {
            id:
              row.id,

            network,

            last4:
              row.last4,

            isDefault:
              row.is_default,

            createdAt:
              new Date(
                row.created_at,
              ).toISOString(),
          };
        },
      );

    methods.sort(
      (
        a,
        b,
      ) => {
        if (
          a.isDefault !==
          b.isDefault
        ) {
          return a.isDefault
            ? -1
            : 1;
        }

        return (
          Date.parse(
            b.createdAt,
          ) -
          Date.parse(
            a.createdAt,
          )
        );
      },
    );

    return {
      methods:
        methods.map(
          ({
            createdAt:
              _createdAt,
            ...method
          }) =>
            method,
        ),
    };
  }

  async setDefault(
    userId: string,
    paymentMethodId:
      string,
  ): Promise<{
    status:
      'updated';

    paymentMethodId:
      string;
  }> {
    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } =
      await admin.rpc(
        'set_default_payment_method',
        {
          p_user_id:
            userId,

          p_payment_method_id:
            paymentMethodId,
        },
      );

    if (
      error ||
      !data
    ) {
      throw new ServiceUnavailableException(
        'Unable to update the default payment method right now.',
      );
    }

    const result =
      data as
        PaymentMethodManagementResult;

    switch (
      result.status
    ) {
      case 'updated':
      case 'existing':
        return {
          status:
            'updated',

          paymentMethodId,
        };

      case 'not_found':
        throw new NotFoundException(
          'Saved payment method not found.',
        );

      case 'unavailable':
        throw new ConflictException(
          'This saved payment method is no longer available.',
        );

      case 'invalid':
        throw new BadRequestException(
          'Unable to update this payment method.',
        );

      default:
        throw new ServiceUnavailableException(
          'Unable to update the default payment method right now.',
        );
    }
  }

  async remove(
    userId: string,
    paymentMethodId:
      string,
  ): Promise<{
    status:
      'removed';

    paymentMethodId:
      string;
  }> {
    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } =
      await admin.rpc(
        'disable_payment_method',
        {
          p_user_id:
            userId,

          p_payment_method_id:
            paymentMethodId,
        },
      );

    if (
      error ||
      !data
    ) {
      throw new ServiceUnavailableException(
        'Unable to remove the saved payment method right now.',
      );
    }

    const result =
      data as
        PaymentMethodManagementResult;

    switch (
      result.status
    ) {
      case 'disabled':
      case 'existing':
        return {
          status:
            'removed',

          paymentMethodId,
        };

      case 'not_found':
        throw new NotFoundException(
          'Saved payment method not found.',
        );

      case 'invalid':
        throw new BadRequestException(
          'Unable to remove this payment method.',
        );

      default:
        throw new ServiceUnavailableException(
          'Unable to remove the saved payment method right now.',
        );
    }
  }
}