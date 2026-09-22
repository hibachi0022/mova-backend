import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';

@Injectable()
export class SupabaseService {
  private readonly url: string;
  private readonly publishableKey: string;
  private readonly secretKey: string;

  constructor(private readonly config: ConfigService) {
    this.url = this.config.getOrThrow<string>('SUPABASE_URL');
    this.publishableKey = this.config.getOrThrow<string>(
      'SUPABASE_PUBLISHABLE_KEY',
    );
    this.secretKey = this.config.getOrThrow<string>(
      'SUPABASE_SECRET_KEY',
    );

    if (new URL(this.url).protocol !== 'https:') {
      throw new Error('SUPABASE_URL must use HTTPS.');
    }

    if (!this.publishableKey.startsWith('sb_publishable_')) {
      throw new Error('Set a valid Supabase publishable key.');
    }

    if (!this.secretKey.startsWith('sb_secret_')) {
      throw new Error('Set a valid Supabase secret key.');
    }
  }

  createClient() {
    return this.buildClient(this.publishableKey);
  }

  createAdminClient() {
    return this.buildClient(this.secretKey);
  }

  private buildClient(key: string) {
    return createClient(this.url, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
  }
}