import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';

@Injectable()
export class SupabaseService {
  private readonly url: string;
  private readonly publishableKey: string;

  constructor(private readonly config: ConfigService) {
    this.url = this.config.getOrThrow<string>('SUPABASE_URL');
    this.publishableKey = this.config.getOrThrow<string>(
      'SUPABASE_PUBLISHABLE_KEY',
    );

    const parsedUrl = new URL(this.url);

    if (parsedUrl.protocol !== 'https:') {
      throw new Error('SUPABASE_URL must use HTTPS.');
    }

    if (!this.publishableKey.startsWith('sb_publishable_')) {
      throw new Error(
        'Set SUPABASE_PUBLISHABLE_KEY to your Supabase publishable key.',
      );
    }
  }

  createClient() {
    return createClient(this.url, this.publishableKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
  }
}