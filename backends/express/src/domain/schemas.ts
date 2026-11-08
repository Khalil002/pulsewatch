import { z } from "zod";

const httpUrl = z.string().max(2048).url().refine((u) => /^https?:\/\//i.test(u), "must start with http:// or https://");

export const registrationSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8).max(72),
  orgName: z.string().trim().min(2).max(60),
});

export const newMemberSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8).max(72),
  role: z.enum(["admin", "viewer"]),
});

export const newApiKeySchema = z.object({ name: z.string().trim().min(1).max(60) });

const monitorFields = {
  name: z.string().trim().min(1).max(100),
  url: httpUrl,
  method: z.enum(["GET", "HEAD"]),
  intervalSec: z.number().int().min(10).max(3600),
  timeoutMs: z.number().int().min(500).max(10000),
  expectedStatus: z.number().int().min(100).max(599),
  alertWebhookUrl: httpUrl.nullable(),
  paused: z.boolean(),
};

export const newMonitorSchema = z.object({
  name: monitorFields.name,
  url: monitorFields.url,
  method: monitorFields.method.default("GET"),
  intervalSec: monitorFields.intervalSec.default(60),
  timeoutMs: monitorFields.timeoutMs.default(5000),
  expectedStatus: monitorFields.expectedStatus.default(200),
  alertWebhookUrl: monitorFields.alertWebhookUrl.default(null),
  paused: monitorFields.paused.default(false),
});
export type NewMonitor = z.infer<typeof newMonitorSchema>;

export const monitorPatchSchema = z.object(monitorFields).partial()
  .refine((p) => Object.values(p).some((v) => v !== undefined), "at least one field is required");
export type MonitorPatch = z.infer<typeof monitorPatchSchema>;
