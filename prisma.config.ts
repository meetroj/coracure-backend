import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

// Prisma 7 keeps connection details out of the schema. The CLI (migrate,
// studio) reads them here; the running service connects through PrismaService.

/**
 * *** THE DATASOURCE IS OMITTED WHEN THERE IS NO URL, NOT FAKED. ***
 *
 * `env()` resolves EAGERLY and throws `PrismaConfigEnvError` when the variable
 * is absent - including for `prisma generate`, which needs no database at all.
 * That broke the image build: `postinstall` runs `generate` during `npm ci`,
 * and the build stage has no `DATABASE_URL` on purpose. It is a runtime secret,
 * and `.dockerignore` keeps `.env` out so a developer's connection string is
 * never baked into a layer.
 *
 * Prisma types `datasource` as optional for exactly this reason - "required for
 * migration / introspection commands" and nothing else - so absent is a
 * supported state rather than a workaround. A placeholder url would be worse:
 * `migrate deploy` would then start against a database that does not exist
 * instead of saying the variable is missing.
 */
const url = process.env.DATABASE_URL;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // `env()` rather than `url` itself, so the value is still resolved by Prisma
  // and a command that connects reports the variable by name.
  ...(url ? { datasource: { url: env('DATABASE_URL') } } : {}),
});
