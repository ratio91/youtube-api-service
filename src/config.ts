import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

// Empty strings count as "unset" so a copied .env.example with blank OAuth
// lines starts the service in transcript-only mode instead of failing.
const optionalString = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().optional()
);

const nonNegativeInt = (fallback: number) =>
  z.coerce.number().int().min(0).default(fallback);
const positiveInt = (fallback: number) =>
  z.coerce.number().int().min(1).default(fallback);

const envSchema = z
  .object({
    // Always required
    BASIC_AUTH_USER: z.string().min(1, 'must be a non-empty string'),
    BASIC_AUTH_PASS: z.string().min(1, 'must be a non-empty string'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),

    // OAuth (optional as a group: all three or none)
    YOUTUBE_CLIENT_ID: optionalString,
    YOUTUBE_CLIENT_SECRET: optionalString,
    OAUTH_REDIRECT_URI: optionalString,
    DEFAULT_PLAYLIST_ID: optionalString,
    TOKEN_PATH: z.string().default('/data/tokens.json'),

    // Transcript backend (yt-dlp subprocess)
    YTDLP_PATH: z.string().default('yt-dlp'),
    // Passed to `yt-dlp --js-runtimes`; "none" disables the flag entirely.
    YTDLP_JS_RUNTIME: z.string().default('node'),
    YTDLP_TIMEOUT_MS: positiveInt(90_000),
    TRANSCRIPT_BATCH_DELAY_MS: nonNegativeInt(3_000),
    TRANSCRIPT_BATCH_MAX: positiveInt(50),
    TRANSCRIPT_MAX_ATTEMPTS: positiveInt(2),
    TRANSCRIPT_RETRY_DELAY_MS: nonNegativeInt(5_000),
    HEALTH_OAUTH_CACHE_MS: nonNegativeInt(300_000),

    // Persistent transcript cache (one file per video + track)
    TRANSCRIPT_CACHE_DIR: z.string().default('/data/transcripts'),
    // How long a "no captions" result is trusted before YouTube is asked again
    NO_CAPTIONS_TTL_DAYS: z.coerce.number().min(0).default(7),

    // Local LLM (OpenAI-compatible, e.g. llama.cpp llama-server) for summaries
    LLM_BASE_URL: z.string().url().default('http://127.0.0.1:8000/v1'),
    LLM_API_KEY: optionalString,
    LLM_MODEL: z.string().default('default'),
    LLM_TIMEOUT_MS: positiveInt(600_000),
    // Context window; when unset the value reported by llama-server /props is used
    LLM_CONTEXT_TOKENS: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.coerce.number().int().min(1024).optional()),
    LLM_MAX_OUTPUT_TOKENS: positiveInt(2000),
    SUMMARY_CHARS_PER_TOKEN: z.coerce.number().min(1).default(3.5),
    SUMMARY_CACHE_DIR: z.string().default('/data/summaries'),
  })
  .superRefine((env, ctx) => {
    const trio = ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET', 'OAUTH_REDIRECT_URI'] as const;
    const present = trio.filter((k) => env[k] !== undefined);
    if (present.length > 0 && present.length < trio.length) {
      for (const k of trio) {
        if (env[k] === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [k],
            message: `missing (OAuth is enabled because ${present.join(', ')} is set; set all of ${trio.join(', ')} or none)`,
          });
        }
      }
    }
    if (env.OAUTH_REDIRECT_URI !== undefined && !z.string().url().safeParse(env.OAUTH_REDIRECT_URI).success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['OAUTH_REDIRECT_URI'], message: 'must be a valid URL' });
    }
  });

const result = envSchema.safeParse(process.env);

if (!result.success) {
  console.error('Invalid environment configuration:');
  for (const issue of result.error.issues) {
    const name = issue.path.join('.');
    const reason =
      issue.code === 'invalid_type' && issue.received === 'undefined' ? 'missing' : issue.message;
    console.error(`  - ${name}: ${reason}`);
  }
  process.exit(1);
}

const env = result.data;

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export const config = {
  ...env,
  /** null → transcript-only mode; OAuth/playlist routes answer 503. */
  oauth:
    env.YOUTUBE_CLIENT_ID && env.YOUTUBE_CLIENT_SECRET && env.OAUTH_REDIRECT_URI
      ? ({
          clientId: env.YOUTUBE_CLIENT_ID,
          clientSecret: env.YOUTUBE_CLIENT_SECRET,
          redirectUri: env.OAUTH_REDIRECT_URI,
        } satisfies OAuthConfig)
      : null,
};

export type Config = typeof config;
