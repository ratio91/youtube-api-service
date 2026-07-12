import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  YOUTUBE_CLIENT_ID: z.string().min(1, 'must be a non-empty string'),
  YOUTUBE_CLIENT_SECRET: z.string().min(1, 'must be a non-empty string'),
  BASIC_AUTH_USER: z.string().min(1, 'must be a non-empty string'),
  BASIC_AUTH_PASS: z.string().min(1, 'must be a non-empty string'),
  OAUTH_REDIRECT_URI: z.string().url('must be a valid URL'),
  PORT: z.coerce.number().default(3000),
  DEFAULT_PLAYLIST_ID: z.string().optional(),
  TOKEN_PATH: z.string().default('/data/tokens.json'),
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  console.error('Invalid environment configuration:');
  for (const issue of result.error.issues) {
    const name = issue.path.join('.');
    const reason = issue.code === 'invalid_type' && issue.received === 'undefined'
      ? 'missing'
      : issue.message;
    console.error(`  - ${name}: ${reason}`);
  }
  process.exit(1);
}

export const config = result.data;
export type Config = typeof config;
