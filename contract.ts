// Shared contract between server.ts and host.ts. The host worker runs on the
// user's machine next to the `higgsfield` CLI, which owns authentication
// (OAuth 2.0 PKCE in the browser — Higgsfield's login page offers Google).
// The plugin never reads or stores the Higgsfield token itself.
import {
  defineRpcContract,
  type ExperimentalHostSignals,
} from "@get-bb/plugin-sdk";
import { z } from "zod";

/** Every host call carries the CLI binary so settings stay server-side. */
const binary = z.string().trim().min(1).max(1024);

/** Raw CLI result: parsed `--json` output, or a classified failure. */
export const cliResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(["auth", "missing-cli", "failed"]),
    message: z.string(),
  }),
]);
export type CliResult = z.infer<typeof cliResultSchema>;

export const hostContract = defineRpcContract({
  accountStatus: {
    input: z.object({ binary }).strict(),
    output: cliResultSchema,
  },
  transactions: {
    input: z
      .object({
        binary,
        size: z.number().int().min(1).max(100),
        cursor: z.string().max(2048).optional(),
      })
      .strict(),
    output: cliResultSchema,
  },
  jobs: {
    input: z
      .object({
        binary,
        size: z.number().int().min(1).max(100),
        kind: z.enum(["image", "video", "audio", "text"]).optional(),
      })
      .strict(),
    output: cliResultSchema,
  },
  /** `higgsfield model list`: model ids, display names, and media type. */
  models: {
    input: z
      .object({
        binary,
        kind: z.enum(["image", "video", "audio", "text"]),
      })
      .strict(),
    output: cliResultSchema,
  },
  workspaceStatus: {
    input: z.object({ binary }).strict(),
    output: cliResultSchema,
  },
  /** Starts `higgsfield auth login` and returns once a URL is known or the flow ends. */
  login: {
    input: z.object({ binary }).strict(),
    output: z.object({
      started: z.boolean(),
      url: z.string().nullable(),
      message: z.string(),
    }),
  },
  logout: {
    input: z.object({ binary }).strict(),
    output: cliResultSchema,
  },
});

export const hostSignals = {
  authChanged: {
    payload: z.object({ ok: z.boolean(), message: z.string() }).strict(),
  },
} satisfies ExperimentalHostSignals;
