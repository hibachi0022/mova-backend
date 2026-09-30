import {
  Injectable,
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
}